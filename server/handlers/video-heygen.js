// api/video-heygen.js — HeyGen AI avatar talking-head video for ThinkinBuddy.
//
// HeyGen API: POST /v2/video/generate with avatar_id + voice + script,
// poll /v1/video_status.get until status='completed', return video URL.
// Requires HEYGEN_API_KEY (not yet set — paste a key + I wire it).
//
// Body: { prompt, userId?, avatarId?, voiceId?, aspect? = 'portrait' | 'square' | 'landscape' }
// prompt = the script the avatar says. Default avatar+voice picked at server.
//
// Cost: ~$0.20-$0.50 per generated minute depending on plan.

import { put } from '@vercel/blob';
import { requireWebhookSecret } from '../../lib/security.js';

const blobPrefix = (userId) => `thinkinbuddy/videos/${userId}/`;

// Defaults — sane "professional male presenter" combo. Override via body.
// Avatar/voice IDs come from a one-time look at /v1/avatars and /v1/voices in
// the HeyGen dashboard; we set the defaults to known-good public IDs.
const DEFAULT_AVATAR_ID = 'Daisy-inskirt-20220818';
const DEFAULT_VOICE_ID  = '2d5b0e6cf36f460aa7fc47e3eee4ba54'; // public female VO

const ASPECT_TO_DIM = {
  portrait:  { width: 720, height: 1280 },
  square:    { width: 720, height: 720 },
  landscape: { width: 1280, height: 720 },
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireWebhookSecret(req, res)) return;

  const prompt = req.body?.prompt || req.query?.prompt;
  if (!prompt) return res.status(400).json({ error: 'prompt (script) required' });

  const userId = req.body?.userId || req.query?.userId || 'anonymous';
  const avatarId = req.body?.avatarId || DEFAULT_AVATAR_ID;
  const voiceId  = req.body?.voiceId  || DEFAULT_VOICE_ID;
  const aspect = (req.body?.aspect || 'portrait').toLowerCase();
  const dim = ASPECT_TO_DIM[aspect] || ASPECT_TO_DIM.portrait;

  const apiKey = process.env.HEYGEN_API_KEY;
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!apiKey)    return res.status(500).json({ result: 'HEYGEN_API_KEY not configured (get one at https://app.heygen.com/settings/api-key)' });
  if (!blobToken) return res.status(500).json({ result: 'BLOB_READ_WRITE_TOKEN not configured' });

  try {
    // Step 1 — kick off generation.
    const startRes = await fetch('https://api.heygen.com/v2/video/generate', {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        video_inputs: [
          {
            character: { type: 'avatar', avatar_id: avatarId, avatar_style: 'normal' },
            voice: { type: 'text', input_text: prompt.slice(0, 1500), voice_id: voiceId },
          },
        ],
        dimension: dim,
        test: false,
      }),
    });

    if (!startRes.ok) {
      const err = await startRes.json().catch(() => ({}));
      const msg = err?.error?.message || err?.message || `HeyGen ${startRes.status}`;
      console.error('[video-heygen] start failed:', msg);
      return res.status(502).json({ result: `HeyGen video failed: ${msg}` });
    }

    const job = await startRes.json();
    const videoId = job?.data?.video_id;
    if (!videoId) return res.status(502).json({ result: 'HeyGen returned no video_id' });

    // Step 2 — poll until completed. HeyGen typical 1-3 min for ~20s clips.
    let status = 'pending';
    let videoUrl = null;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline && status !== 'completed' && status !== 'failed') {
      await new Promise((r) => setTimeout(r, 6000));
      const poll = await fetch(
        `https://api.heygen.com/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`,
        { headers: { 'X-Api-Key': apiKey } },
      );
      if (!poll.ok) break;
      const taskState = await poll.json();
      status = taskState?.data?.status || status;
      if (status === 'completed') {
        videoUrl = taskState?.data?.video_url;
      }
    }

    if (status !== 'completed' || !videoUrl) {
      return res.status(504).json({ result: `HeyGen video ended in ${status}` });
    }

    // Step 3 — rehost to Blob.
    const dl = await fetch(videoUrl);
    if (!dl.ok) return res.status(502).json({ result: 'HeyGen content download failed' });
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
        JSON.stringify({ prompt, provider: 'heygen', avatarId, voiceId, dim }),
        { access: 'public', contentType: 'application/json', addRandomSuffix: false, token: blobToken },
      );
    } catch (err) {
      console.error('[video-heygen] sidecar write failed (non-fatal):', err?.message || err);
    }

    return res.status(200).json({
      result: 'Video generated.',
      url: blob.url,
      prompt,
      provider: 'heygen',
    });
  } catch (err) {
    console.error('[video-heygen] error:', err?.message || err);
    return res.status(502).json({ result: `HeyGen video error: ${err?.message || 'unknown'}` });
  }
}
