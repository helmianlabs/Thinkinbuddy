// api/video.js — Mark's primary "make a video" tool endpoint.
//
// 2026-06-12 RUNWAY BRIDGE: Troy's Runway tier rejects pure text-to-video but
// ACCEPTS image-to-video on gen4 models (documented finding,
// video-runway.js:14-22). This orchestrates the path that works on his
// existing plans:
//   1. prompt → start frame via OpenAI images (same pipeline as image.js)
//   2. start frame + prompt → Runway gen4_turbo image-to-video
//   3. rehost the mp4 to Blob + sidecar meta + save to media memory
// (OpenAI Sora was removed in Oct 2026 — the Videos API was retired;
// pure-text video now goes through the Veo paths.)
//
// Body: { prompt, userId?, aspect? = 'landscape'|'portrait'|'square', seconds? = 10, promptImage? }
// If promptImage is supplied we skip step 1 and animate that image directly.

import { put } from '@vercel/blob';
import { requireWebhookSecret } from '../../lib/security.js';
import { isAllowed, SAFE_REFUSAL } from '../../lib/moderation.js';
import { resolveKey } from '../../lib/userKeys.js';
import { resolveHandlerTenant } from '../../lib/tenant.js';
import { costFor, meterGate, denyMetering, recordMetered, getUsageDb } from '../../lib/usage.js';
import { randomUUID } from 'node:crypto';
import { safetyDecision, safetyInputsFromRequest } from '../../lib/safety.js';
import { getProfile, getProfileDb, profileSafety } from '../../lib/profile.js';
import { saveMediaMemory } from '../../lib/mediaMemory.js';

export const config = { maxDuration: 300 };

const RUNWAY_MODEL = 'gen4_turbo';
const blobPrefix = (userId) => `thinkinbuddy/videos/${userId}/`;

const ASPECT_TO_RATIO = {
  portrait: '720:1280',
  square: '768:768',
  landscape: '1280:720',
};
// gpt-image accepts only these sizes; closest to each video ratio.
const ASPECT_TO_IMG_SIZE = {
  portrait: '1024x1536',
  square: '1024x1024',
  landscape: '1536x1024',
};

async function makeStartFrame({ prompt, aspect, apiKey, blobToken, userId }) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-2',
      prompt: `Cinematic still frame, the opening frame of a video: ${prompt}`,
      size: ASPECT_TO_IMG_SIZE[aspect] || ASPECT_TO_IMG_SIZE.landscape,
      n: 1,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`start-frame image failed: ${err?.error?.message || res.status}`);
  }
  const data = await res.json();
  const url = data?.data?.[0]?.url;
  const b64 = data?.data?.[0]?.b64_json;
  if (url) return url;
  if (!b64) throw new Error('start-frame image returned no content');
  // Rehost b64 to Blob so Runway can fetch it by public URL.
  const buf = Buffer.from(b64, 'base64');
  const blob = await put(
    `thinkinbuddy/images/${userId}/startframe-${Date.now()}.png`,
    buf,
    { access: 'public', contentType: 'image/png', addRandomSuffix: false, token: blobToken },
  );
  return blob.url;
}

async function startRunwayTask({ apiKey, promptText, promptImage, ratio, duration }) {
  const body = JSON.stringify({
    model: RUNWAY_MODEL,
    promptText,
    promptImage,
    ratio,
    duration,
  });
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Runway-Version': '2024-11-06',
  };
  // image_to_video is the documented endpoint for promptImage workflows;
  // fall back to the legacy text_to_video+promptImage shape on a 4xx.
  let lastErr = '';
  for (const path of ['image_to_video', 'text_to_video']) {
    const res = await fetch(`https://api.dev.runwayml.com/v1/${path}`, {
      method: 'POST',
      headers,
      body,
    });
    if (res.ok) return res.json();
    const err = await res.json().catch(() => ({}));
    lastErr = JSON.stringify(err).slice(0, 300);
    console.error(`[video] runway ${path} failed:`, res.status, lastErr);
    if (res.status >= 500) throw new Error(`Runway ${res.status} on ${path}`);
  }
  throw new Error(`Runway rejected the job on both endpoints — ${lastErr}`);
}

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

  const aspect = (req.body?.aspect || 'landscape').toLowerCase();
  const ratio = ASPECT_TO_RATIO[aspect] || ASPECT_TO_RATIO.landscape;
  const seconds = [5, 10].includes(parseInt(req.body?.seconds, 10))
    ? parseInt(req.body?.seconds, 10)
    : 10;

  const { key: openaiKey, source: openaiSource } = resolveKey(req, 'OPENAI_API_KEY');
  const { key: runwayKey, source: keySource } = resolveKey(req, 'RUNWAY_API_KEY');
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!openaiKey) return res.status(500).json({ result: 'OPENAI_API_KEY not configured' });
  if (!runwayKey) return res.status(500).json({ result: 'RUNWAY_API_KEY not configured' });
  if (!blobToken) return res.status(500).json({ result: 'BLOB_READ_WRITE_TOKEN not configured' });

  // Hosted mode: the tenant profile decides fail-closed (lib/profile.js
  // profileSafety) when a profile row exists; request inputs are the
  // fallback, and compat mode never queries a profile.
  let { failClosed } = safetyDecision(safetyInputsFromRequest(req));
  if (resolvedTenant.enforced && resolvedTenant.tenantId) {
    try {
      const profile = await getProfile(getProfileDb, resolvedTenant.tenantId);
      if (profile) ({ failClosed } = profileSafety(profile));
    } catch (e) {
      console.error('[video] profile load failed — request safety inputs used:', e?.message || e);
    }
  }
  const mod = await isAllowed(prompt, openaiKey, { failClosed });
  if (!mod.allowed) {
    console.warn('[video] prompt blocked by moderation:', mod.reason);
    return res.status(200).json({ result: SAFE_REFUSAL });
  }


  // Usage metering (hosted model, lib/usage.js): enforced mode + our
  // server key -> the tenant's bucket must cover the estimate BEFORE
  // the provider call (402 credits_exhausted, no provider call made).
  // Compat mode and BYO user keys skip metering entirely — see
  // shouldMeter in lib/usage.js.
  const vidReqId = randomUUID();
  const vidEst = costFor('video', { seconds });
  const vidGate = await meterGate({ db: getUsageDb, tenantId: resolvedTenant.tenantId, keySource: keySource, estCredits: vidEst });
  if (!vidGate.allowed) return denyMetering(res, vidGate);

  try {
    // 1. Start frame (skipped when the caller supplies one).
    const promptImage =
      req.body?.promptImage ||
      (await makeStartFrame({ prompt, aspect, apiKey: openaiKey, blobToken, userId }));

    // 2. Runway image-to-video.
    const job = await startRunwayTask({
      apiKey: runwayKey,
      promptText: prompt,
      promptImage,
      ratio,
      duration: seconds,
    });
    const taskId = job?.id;
    if (!taskId) return res.status(502).json({ result: 'Runway returned no task id' });

    // 3. Poll until done (~2-3 min typical for short clips).
    let status = 'PENDING';
    let outputUrl = null;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline && status !== 'SUCCEEDED' && status !== 'FAILED') {
      await new Promise((r) => setTimeout(r, 5000));
      const poll = await fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${runwayKey}`, 'X-Runway-Version': '2024-11-06' },
      });
      if (!poll.ok) break;
      const t = await poll.json();
      status = t?.status || status;
      if (status === 'SUCCEEDED') {
        outputUrl = Array.isArray(t?.output) ? t.output[0] : null;
      }
    }
    if (status !== 'SUCCEEDED' || !outputUrl) {
      return res.status(504).json({ result: `Runway video ended in ${status}` });
    }

    // 4. Rehost to Blob (the widget's poller reads from here).
    const dl = await fetch(outputUrl);
    if (!dl.ok) return res.status(502).json({ result: 'Runway content download failed' });
    const buf = Buffer.from(await dl.arrayBuffer());
    const ts = Date.now();
    const blob = await put(`${blobPrefix(userId)}${ts}.mp4`, buf, {
      access: 'public',
      contentType: 'video/mp4',
      addRandomSuffix: false,
      token: blobToken,
    });
    try {
      await put(
        `${blobPrefix(userId)}${ts}.meta.json`,
        JSON.stringify({ prompt, provider: 'runway-i2v', ratio, seconds }),
        { access: 'public', contentType: 'application/json', addRandomSuffix: false, token: blobToken },
      );
    } catch (e) {
      console.error('[video] sidecar write failed (non-fatal):', e?.message || e);
    }

    // 5. Media memory (fire-and-forget — never fail the response on it).
    saveMediaMemory({
      userId,
      type: 'video',
      blobUrl: blob.url,
      prompt,
      tenantId: resolvedTenant.tenantId,
    }).catch((e) => console.error('[video] media memory save failed:', e?.message || e));

    await recordMetered(vidGate, getUsageDb, {
      tenantId: resolvedTenant.tenantId, provider: 'runway', action: 'video',
      units: seconds, credits: vidEst, requestId: vidReqId,
    });

    return res.status(200).json({
      result: 'Video generated.',
      url: blob.url,
      prompt,
      provider: 'runway-i2v',
    });
  } catch (err) {
    console.error('[video] error:', err?.message || err);
    return res.status(502).json({ result: `Video error: ${err?.message || 'unknown'}` });
  }
}
