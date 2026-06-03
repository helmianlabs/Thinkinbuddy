// api/video-runway.js — Runway Gen-3 / Gen-4 video generation for ThinkinBuddy.
//
// Uses RUNWAY_API_KEY (already provisioned on Vercel 7d ago).
// Runway charges per second of generated video; default 5s keeps cost low.
//
// Body: { prompt, userId?, aspect? = 'portrait' | 'square' | 'landscape', seconds? = 5 }

import { put } from '@vercel/blob';
import { requireWebhookSecret } from '../lib/security.js';

// Runway text-to-video model. Account tier determines what's available.
// gen3a_turbo is the older Gen-3 text-to-video model (returned "not available"
// on Troy's account 2026-06-02 — possibly tier-gated or renamed).
// veo3 / gen4_aleph / gen4_turbo are image-to-video only on most tiers.
// We accept body.model to override at call time so the LLM/Troy can pick.
const DEFAULT_MODEL = 'gen3a_turbo';
const blobPrefix = (userId) => `thinkinbuddy/videos/${userId}/`;

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
  const aspect = (req.body?.aspect || 'portrait').toLowerCase();
  const ratio = ASPECT_TO_RATIO[aspect] || ASPECT_TO_RATIO.portrait;
  const seconds = [5, 10].includes(parseInt(req.body?.seconds, 10))
    ? parseInt(req.body?.seconds, 10)
    : 5;

  const apiKey = process.env.RUNWAY_API_KEY;
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!apiKey)    return res.status(500).json({ result: 'RUNWAY_API_KEY not configured' });
  if (!blobToken) return res.status(500).json({ result: 'BLOB_READ_WRITE_TOKEN not configured' });

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
