// api/video-runway.js — Runway Gen-3 / Gen-4 video generation for ThinkinBuddy.
//
// Uses RUNWAY_API_KEY (already provisioned on Vercel 7d ago).
// Runway charges per second of generated video; default 5s keeps cost low.
//
// Body: { prompt, userId?, aspect? = 'portrait' | 'square' | 'landscape', seconds? = 5 }

import { put } from '@vercel/blob';
import { requireWebhookSecret } from '../../lib/security.js';
import { isAllowed, SAFE_REFUSAL } from '../../lib/moderation.js';
import { getKey, resolveKey } from '../../lib/userKeys.js';
import { resolveHandlerTenant } from '../../lib/tenant.js';
import { costFor, meterGate, denyMetering, recordMetered, getUsageDb } from '../../lib/usage.js';
import { randomUUID } from 'node:crypto';
import { safetyDecision, safetyInputsFromRequest } from '../../lib/safety.js';

// Runway model variant.
//
// 2026-06-02 FINDING — Troy's current Runway tier:
//   - gen3a_turbo  → "not available" (deprecated or tier-gated)
//   - gen4_turbo / gen4_aleph / veo3 / seedance / aleph → all require
//     promptImage (image-to-video only)
//   - Pure text-to-video is NOT enabled on this account.
//
// For pure text prompts → use /api/video-sora (works on Troy's OpenAI tier).
// To wake Runway up, either upgrade the Runway plan to one that includes
// text-to-video, OR call this route with a promptImage URL for image-to-video.
const DEFAULT_MODEL = 'gen4_turbo';
const blobPrefix = (userId) => `thinkinbuddy/videos/${userId}/`;

// Runway gen + polling takes minutes — raise the function ceiling to avoid 504.
export const config = { maxDuration: 300 };

const ASPECT_TO_RATIO = {
  portrait:  '720:1280',
  square:    '768:768',
  landscape: '1280:720',
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireWebhookSecret(req, res)) return;

  const prompt = req.body?.prompt || req.query?.prompt;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const userId = req.body?.userId || req.query?.userId || 'anonymous';
  // Tenant for metering (lib/tenant.js, bite-1b pattern): compat mode
  // resolves ok with no scoping tenant and the metering block below is
  // a no-op; enforced (hosted) mode requires a session token or the
  // tenant id carried as userId.
  const resolvedTenant = resolveHandlerTenant(req, userId);
  if (!resolvedTenant.ok) {
    return res.status(400).json({ error: 'tenant identity required (session token or tenant user_id)' });
  }

  const aspect = (req.body?.aspect || 'portrait').toLowerCase();
  const ratio = ASPECT_TO_RATIO[aspect] || ASPECT_TO_RATIO.portrait;
  const seconds = [5, 10].includes(parseInt(req.body?.seconds, 10))
    ? parseInt(req.body?.seconds, 10)
    : 5;

  const { key: apiKey, source: keySource } = resolveKey(req, 'RUNWAY_API_KEY');
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!apiKey)    return res.status(500).json({ result: 'RUNWAY_API_KEY not configured' });
  if (!blobToken) return res.status(500).json({ result: 'BLOB_READ_WRITE_TOKEN not configured' });

  // Kid-safe gate: moderate the prompt via OpenAI BEFORE calling Runway.
  const { failClosed } = safetyDecision(safetyInputsFromRequest(req));
  const mod = await isAllowed(prompt, getKey(req, 'OPENAI_API_KEY'), { failClosed });
  if (!mod.allowed) {
    console.warn('[video-runway] prompt blocked by moderation:', mod.reason);
    return res.status(200).json({ result: SAFE_REFUSAL });
  }


  // Usage metering (hosted model, lib/usage.js): enforced mode + our
  // server key -> the tenant's bucket must cover the estimate BEFORE
  // the provider call (402 credits_exhausted, no provider call made).
  // Compat mode and BYO user keys skip metering entirely — see
  // shouldMeter in lib/usage.js.
  const rwReqId = randomUUID();
  const rwEst = costFor('video', { seconds });
  const rwGate = await meterGate({ db: getUsageDb, tenantId: resolvedTenant.tenantId, keySource: keySource, estCredits: rwEst });
  if (!rwGate.allowed) return denyMetering(res, rwGate);

  try {
    // Runway uses text_to_video task creation.
    const startRes = await fetch('https://api.dev.runwayml.com/v1/text_to_video', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Runway-Version': '2024-11-06',
      },
      body: JSON.stringify({
        model: req.body?.model || DEFAULT_MODEL,
        promptText: prompt,
        promptImage: req.body?.promptImage, // image-to-video on Gen-4+
        ratio,
        duration: seconds,
      }),
    });

    if (!startRes.ok) {
      const err = await startRes.json().catch(() => ({}));
      // Surface as much detail as Runway returned — generic 'Validation of body
      // failed' alone hides whether the model, ratio, or duration is at fault.
      const detail = err?.detail || err?.error?.message || err?.message || '';
      const msg =
        (err?.error && typeof err.error === 'string' ? err.error : '') ||
        `Runway ${startRes.status}`;
      console.error('[video-runway] start failed:', { status: startRes.status, msg, detail, raw: err });
      return res.status(502).json({
        result: `Runway video failed: ${msg}${detail ? ` — ${JSON.stringify(detail).slice(0, 200)}` : ''}`,
      });
    }

    const job = await startRes.json();
    const taskId = job?.id;
    if (!taskId) return res.status(502).json({ result: 'Runway returned no task id' });

    // Poll Runway task status. ~2-3 min typical for 5s clips.
    let status = 'PENDING';
    let outputUrl = null;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline && status !== 'SUCCEEDED' && status !== 'FAILED') {
      await new Promise((r) => setTimeout(r, 5000));
      const poll = await fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'X-Runway-Version': '2024-11-06',
        },
      });
      if (!poll.ok) break;
      const taskState = await poll.json();
      status = taskState?.status || status;
      if (status === 'SUCCEEDED') {
        outputUrl = Array.isArray(taskState?.output) ? taskState.output[0] : null;
      }
    }

    if (status !== 'SUCCEEDED' || !outputUrl) {
      return res.status(504).json({ result: `Runway video ended in ${status}` });
    }

    // Rehost the result video to Blob so the widget poller picks it up.
    const dl = await fetch(outputUrl);
    if (!dl.ok) return res.status(502).json({ result: 'Runway content download failed' });
    const buf = Buffer.from(await dl.arrayBuffer());
    const ts = Date.now();
    const key = `${blobPrefix(userId)}${ts}.mp4`;
    const blob = await put(key, buf, {
      access: 'public',
      contentType: 'video/mp4',
      addRandomSuffix: false,
      token: blobToken,
    });

    try {
      await put(
        `${blobPrefix(userId)}${ts}.meta.json`,
        JSON.stringify({ prompt, provider: 'runway', ratio, seconds }),
        { access: 'public', contentType: 'application/json', addRandomSuffix: false, token: blobToken },
      );
    } catch (err) {
      console.error('[video-runway] sidecar write failed (non-fatal):', err?.message || err);
    }

    await recordMetered(rwGate, getUsageDb, {
      tenantId: resolvedTenant.tenantId, provider: 'runway', action: 'video',
      units: seconds, credits: rwEst, requestId: rwReqId,
    });

    return res.status(200).json({
      result: 'Video generated.',
      url: blob.url,
      prompt,
      provider: 'runway',
    });
  } catch (err) {
    console.error('[video-runway] error:', err?.message || err);
    return res.status(502).json({ result: `Runway video error: ${err?.message || 'unknown'}` });
  }
}
