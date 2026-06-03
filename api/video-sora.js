// api/video-sora.js — OpenAI Sora video generation for ThinkinBuddy.
//
// OpenAI Sora 2 / Sora Turbo video API. Reuses the existing OPENAI_API_KEY
// (no new key — Sora access is enabled on the account tier).
// Currently in public preview as of late 2026 — endpoint shape may evolve.
//
// Body: { prompt, userId?, aspect? = 'portrait' | 'square' | 'landscape', seconds? = 5 }
// Returns: { result: 'Video generated.', url, prompt } — same shape image.js
// uses so the widget's media poller can show it the same way.

import { put } from '@vercel/blob';
import { requireWebhookSecret } from '../lib/security.js';

const MODEL = 'sora-2';
const blobPrefix = (userId) => `thinkinbuddy/videos/${userId}/`;

// Video generation + polling takes minutes. Without this, the Vercel function
// is killed at the platform default (~10-60s) → 504 before the video is ready.
// 300s is the Pro-plan max. Most 4-12s Sora clips finish well within it.
export const config = { maxDuration: 300 };

// OpenAI Sora-2 ONLY accepts these exact sizes — 720x720 is NOT valid and
// returns "Invalid size". Map square -> portrait (closest phone-friendly).
const ASPECT_TO_SIZE = {
  square:    '720x1280', // Sora has no square; use portrait
  portrait:  '720x1280',
  landscape: '1280x720',
};

// Sora-2 ONLY accepts these exact durations. Any other value (e.g. the old
// default of 5, or "10") returns "Invalid seconds". Snap to the nearest valid.
const VALID_SORA_SECONDS = [4, 8, 12];
function snapSeconds(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 4;
  // pick the closest allowed value
  return VALID_SORA_SECONDS.reduce((best, v) =>
    Math.abs(v - n) < Math.abs(best - n) ? v : best,
  VALID_SORA_SECONDS[0]);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireWebhookSecret(req, res)) return;

  const prompt = req.body?.prompt || req.query?.prompt;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const userId = req.body?.userId || req.query?.userId || 'anonymous';
  const aspect = (req.body?.aspect || 'portrait').toLowerCase();
  const size = ASPECT_TO_SIZE[aspect] || ASPECT_TO_SIZE.portrait;
  const seconds = snapSeconds(req.body?.seconds ?? 4);

  const apiKey = process.env.OPENAI_API_KEY;
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!apiKey)    return res.status(500).json({ result: 'OPENAI_API_KEY not configured' });
  if (!blobToken) return res.status(500).json({ result: 'BLOB_READ_WRITE_TOKEN not configured' });

  try {
    // Step 1: kick off the video generation job (async).
    // OpenAI occasionally returns a transient 5xx "Server error" at job
    // creation — retry up to 3 times with backoff before giving up.
    let startRes;
    let startErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      startRes = await fetch('https://api.openai.com/v1/videos', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          prompt,
          size,
          seconds: String(seconds),
        }),
      });
      if (startRes.ok) break;
      const errBody = await startRes.json().catch(() => ({}));
      startErr = errBody?.error?.message || `OpenAI ${startRes.status}`;
      // Only retry on 5xx (server-side). 4xx (bad prompt/size) won't fix itself.
      if (startRes.status < 500) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }

    if (!startRes.ok) {
      console.error('[video-sora] start failed after retries:', startErr);
      return res.status(502).json({ result: `Sora video failed: ${startErr}` });
    }

    const job = await startRes.json();
    const jobId = job?.id;
    if (!jobId) return res.status(502).json({ result: 'Sora returned no job id' });

    // KICK-AND-RETURN. We do NOT poll-to-completion here — video gen takes
    // minutes and the serverless function times out (~10s plan cap) → 504.
    // Instead we write a pending marker to Blob and return immediately. The
    // widget's video poller hits /api/latest-video every 3s, which finalizes
    // any completed Sora job (downloads MP4 → Blob) and serves it. So the
    // video appears in the widget shortly after it finishes, no 504.
    const ts = Date.now();
    const pendingKey = `${blobPrefix(userId)}pending-${jobId}.json`;
    try {
      await put(
        pendingKey,
        JSON.stringify({ jobId, prompt, provider: 'sora', size, seconds, userId, createdAt: ts }),
        { access: 'public', contentType: 'application/json', addRandomSuffix: false, token: blobToken },
      );
    } catch (err) {
      console.error('[video-sora] pending marker write failed:', err?.message || err);
      // Non-fatal — finalizer can also discover jobs via OpenAI list, but the
      // marker is the primary path. Surface as a soft warning to the caller.
    }

    // Speakable success — the video is on its way, not done yet.
    return res.status(202).json({
      result: 'Video is generating — it will appear on screen in under a minute.',
      jobId,
      prompt,
      provider: 'sora',
      pending: true,
    });
  } catch (err) {
    console.error('[video-sora] error:', err?.message || err);
    return res.status(502).json({ result: `Sora video error: ${err?.message || 'unknown'}` });
  }
}
