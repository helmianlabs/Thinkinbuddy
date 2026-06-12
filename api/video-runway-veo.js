// api/video.js — short video generation for ThinkinBuddy.
//
// Uses Runway's API (gen4_turbo via /v1/text_to_video). Runway returns a task
// ID; we poll /v1/tasks/{id} until status is SUCCEEDED, then download the MP4
// and upload it to Vercel Blob so the widget can render it from a stable URL
// and /api/latest-video can find it across cold starts.
//
// HARD LIMIT — Runway text_to_video caps duration at 4/6/8 seconds per call.
// If a caller asks for "1 minute", we silently cap to 8s — the tool description
// in ElevenLabs makes this explicit so the agent sets expectations up-front.

import { put } from '@vercel/blob';
import { requireWebhookSecret } from '../lib/security.js';
import { saveMediaMemory } from '../lib/mediaMemory.js';

const RUNWAY_BASE = 'https://api.dev.runwayml.com/v1';
const RUNWAY_VERSION = '2024-11-06';
const MODEL = 'veo3'; // text_to_video on Runway — veo3 is the most reliable;
                       // gen4_turbo is image-to-video only. veo3 returns ~8s clips.
const DEFAULT_DURATION = 8;
const ALLOWED_DURATIONS = [4, 6, 8]; // text_to_video allowed values
const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 270000; // 4.5 min — leaves headroom under our 300s maxDuration

const blobPrefix = (userId) => `thinkinbuddy/videos/${userId}/`;

export const maxDuration = 300;

export default async function handler(req, res) {
  // Shared-secret gate. Called server-to-server by the ElevenLabs agent
  // as a tool webhook — no browser, so CORS is the wrong gate. The agent
  // config must send X-Webhook-Secret matching WEBHOOK_SECRET. Runway
  // calls are EXPENSIVE so this hole was the highest billing risk.
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireWebhookSecret(req, res)) return;

  const prompt = req.body?.prompt || req.query?.prompt;
  if (!prompt) return res.status(400).json({ result: 'prompt required' });

  const userId = req.body?.userId || req.query?.userId || 'anonymous';
  let duration = Number(req.body?.duration || req.query?.duration || DEFAULT_DURATION);
  if (!ALLOWED_DURATIONS.includes(duration)) {
    // Snap to nearest allowed value rather than failing
    duration = duration >= 7 ? 8 : (duration >= 5 ? 6 : 4);
  }

  const apiKey = process.env.RUNWAY_API_KEY;
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!apiKey)    return res.status(500).json({ result: 'RUNWAY_API_KEY not configured' });
  if (!blobToken) return res.status(500).json({ result: 'BLOB_READ_WRITE_TOKEN not configured' });

  try {
    // 1) Kick off the generation task
    const createRes = await fetch(`${RUNWAY_BASE}/text_to_video`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Runway-Version': RUNWAY_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        promptText: prompt,
        ratio: '1280:720',
        duration,
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => '');
      let err = {};
      try { err = JSON.parse(errText); } catch {}
      const msg = err?.error || err?.message || errText || `Runway ${createRes.status}`;
      console.error('[video] Runway create error:', createRes.status, errText);
      return res.status(502).json({ result: `Video generation failed: ${msg}` });
    }

    const createData = await createRes.json();
    const taskId = createData?.id;
    if (!taskId) {
      console.error('[video] Runway returned no task id:', JSON.stringify(createData));
      return res.status(502).json({ result: 'Runway returned no task id' });
    }

    // 2) Poll until done
    const startedAt = Date.now();
    let videoUrl = null;
    let lastStatus = 'PENDING';
    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      const taskRes = await fetch(`${RUNWAY_BASE}/tasks/${taskId}`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'X-Runway-Version': RUNWAY_VERSION,
        },
      });
      if (!taskRes.ok) {
        // Transient — keep polling
        continue;
      }
      const task = await taskRes.json();
      lastStatus = task?.status;
      if (lastStatus === 'SUCCEEDED') {
        videoUrl = Array.isArray(task?.output) ? task.output[0] : null;
        break;
      }
      if (lastStatus === 'FAILED' || lastStatus === 'CANCELLED') {
        const failMsg = task?.failure || task?.failureCode || lastStatus;
        console.error('[video] Runway task failed:', failMsg);
        return res.status(502).json({ result: `Video generation failed: ${failMsg}` });
      }
    }

    if (!videoUrl) {
      console.error('[video] Runway poll timed out at status', lastStatus);
      return res.status(504).json({ result: `Video generation timed out (last status: ${lastStatus})` });
    }

    // 3) Download the MP4 and stash it in Vercel Blob
    const dl = await fetch(videoUrl);
    if (!dl.ok) {
      console.error('[video] failed to download Runway output:', dl.status);
      return res.status(502).json({ result: 'Failed to download generated video' });
    }
    const buf = Buffer.from(await dl.arrayBuffer());
    const ts = Date.now();
    const key = `${blobPrefix(userId)}${ts}.mp4`;
    const blob = await put(key, buf, {
      access: 'public',
      contentType: 'video/mp4',
      addRandomSuffix: false,
      token: blobToken,
    });

    // Sidecar with prompt (mirrors image flow)
    try {
      await put(
        `${blobPrefix(userId)}${ts}.meta.json`,
        JSON.stringify({ prompt, duration }),
        { access: 'public', contentType: 'application/json', addRandomSuffix: false, token: blobToken }
      );
    } catch (err) {
      console.error('[video] sidecar write failed (non-fatal):', err?.message || err);
    }
    // Persist to Neon memory so this video is recallable by semantic search.
    saveMediaMemory({ userId, type: 'video', blobUrl: blob.url, prompt, createdAt: ts }).catch(
      (e) => console.error('[video] saveMediaMemory failed (non-fatal):', e?.message || e)
    );

    return res.status(200).json({
      result: `Video generated (${duration}s).`,
      url: blob.url,
      prompt,
      duration,
    });
  } catch (err) {
    console.error('[video] error:', err?.message || err);
    return res.status(502).json({ result: `Video generation error: ${err?.message || 'unknown'}` });
  }
}
