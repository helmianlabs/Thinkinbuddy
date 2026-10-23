import { resolveKey, getKey, missingKeyError } from '../../lib/userKeys.js';
import { isAllowed, SAFE_REFUSAL } from '../../lib/moderation.js';
import { requireTenant, tenantEnforced } from '../../lib/tenant.js';
import { costFor, meterGate, denyMetering, recordMetered, getUsageDb } from '../../lib/usage.js';
import { getProfile, getProfileDb, profileSafety } from '../../lib/profile.js';
import { randomUUID } from 'node:crypto';
import { safetyDecision, safetyInputsFromRequest } from '../../lib/safety.js';

// Fallback voice, used when the caller names none. Unchanged from the
// original hardcoded value so existing callers keep the same voice.
const DEFAULT_VOICE_ID = 'nPczCjzI2devNBz1zQrb';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Key-ELEVENLABS, X-User-Key-OPENAI');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Tenant gate (bite-1b compat pattern, lib/tenant.js): with
  // SESSION_SECRET unset — today's live deployment — requireTenant
  // returns the legacy tenant and this behaves exactly as before. With
  // SESSION_SECRET set (hosted multi-tenant), a valid tenant session is
  // required: until now this endpoint had NO auth at all, and an
  // unauthenticated caller could burn the server's ElevenLabs key
  // (audit §2 gap 3).
  const tenant = requireTenant(req, res);
  if (!tenant) return; // requireTenant wrote the 401

  let { text, voiceId: requestedVoiceId } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });

  // Pronunciation corrections
  text = text.replace(/shoshone/gi, 'sho-shown');

  // Kid-safe gate: moderate the text BEFORE it is spoken (audit §2
  // gap 3 — this endpoint used to speak anything verbatim). Blocked
  // text gets the repo's standard refusal shape; nothing is sent to
  // ElevenLabs. Fails closed when safety applies to this request.
  // Hosted mode: the tenant profile decides safety (lib/profile.js
  // profileSafety) when a profile row exists; the request inputs are
  // the fallback, and compat mode never queries a profile.
  let safety = safetyDecision(safetyInputsFromRequest(req));
  if (tenantEnforced() && tenant?.tenantId) {
    try {
      const profile = await getProfile(getProfileDb, tenant.tenantId);
      if (profile) safety = profileSafety(profile);
    } catch (e) {
      console.error('[speak] profile load failed — request safety inputs used:', e?.message || e);
    }
  }
  const mod = await isAllowed(text, getKey(req, 'OPENAI_API_KEY'), { failClosed: safety.failClosed });
  if (!mod.allowed) {
    console.warn('[speak] text blocked by moderation:', mod.reason);
    return res.status(200).json({ result: SAFE_REFUSAL });
  }

  const { key: apiKey, source: keySource } = resolveKey(req, 'ELEVENLABS_API_KEY');
  if (!apiKey) return res.status(400).json(missingKeyError('ELEVENLABS_API_KEY'));

  // Usage metering (hosted model, lib/usage.js): enforced mode + our
  // server ElevenLabs key -> bucket check BEFORE the TTS call (402 when
  // exhausted). A user-supplied ElevenLabs key (BYO) or compat mode
  // skips metering entirely. Cost is per 100 chars of the final text.
  const speakReqId = randomUUID();
  const speakEst = costFor('speak', { text });
  const speakGate = await meterGate({
    db: getUsageDb, tenantId: tenant.tenantId, keySource, estCredits: speakEst,
  });
  if (!speakGate.allowed) return denyMetering(res, speakGate);

  // Accept only an id-shaped value — this is interpolated into the URL.
  const voiceId = (typeof requestedVoiceId === 'string' && /^[A-Za-z0-9]{16,40}$/.test(requestedVoiceId))
    ? requestedVoiceId
    : DEFAULT_VOICE_ID;

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: 1.0 }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    return res.status(response.status).json({ error: err });
  }

  const audioBuffer = await response.arrayBuffer();
  await recordMetered(speakGate, getUsageDb, {
    tenantId: tenant.tenantId, provider: 'elevenlabs', action: 'speak',
    units: text.length, credits: speakEst, requestId: speakReqId,
  });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', audioBuffer.byteLength);
  res.send(Buffer.from(audioBuffer));
}
