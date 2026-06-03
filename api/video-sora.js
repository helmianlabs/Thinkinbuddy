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
    const startRes = await fetch('https://api.openai.com/v1/videos', {
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

    if (!startRes.ok) {
      const err = await startRes.json().catch(() => ({}));
      const msg = err?.error?.message || `OpenAI ${startRes.status}`;
      console.error('[video-sora] start failed:', msg);
      return res.status(502).json({ result: `Sora video failed: ${msg}` });
    }

    const job = await startRes.json();
    const jobId = job?.id;
    if (!jobId) return res.status(502).json({ result: 'Sora returned no job id' });

    // Step 2: poll for completion (cap at ~3 min — videos finish within that window).
    let status = job.status || 'queued';
    let finalJob = job;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline && status !== 'completed' && status !== 'failed') {
      await new Promise((r) => setTimeout(r, 4000));
      const poll = await fetch(`https://api.openai.com/v1/videos/${jobId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!poll.ok) break;
      finalJob = await poll.json();
      status = finalJob?.status || status;
    }

    if (status !== 'completed') {
      return res.status(504).json({ result: `Sora video still ${status} after timeout` });
    }

    // Step 3: download the result MP4 + rehost to Blob for widget display.
    const contentUrl = await fetch(
      `https://api.openai.com/v1/videos/${jobId}/content`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!contentUrl.ok) {
      return res.status(502).json({ result: 'Sora content download failed' });
    }
    const buf = Buffer.from(await contentUrl.arrayBuffer());
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
        JSON.stringify({ prompt, provider: 'sora', size, seconds }),
        { access: 'public', contentType: 'application/json', addRandomSuffix: false, token: blobToken },
      );
    } catch (err) {
      console.error('[video-sora] sidecar write failed (non-fatal):', err?.message || err);
    }

    return res.status(200).json({
      result: 'Video generated.',
      url: blob.url,
      prompt,
      provider: 'sora',
    });
  } catch (err) {
    console.error('[video-sora] error:', err?.message || err);
    return res.status(502).json({ result: `Sora video error: ${err?.message || 'unknown'}` });
  }
}
