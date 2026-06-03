// api/image-imagen.js — Google Imagen image generation for ThinkinBuddy.
//
// Uses GOOGLE_API_KEY (NOT YET SET on Vercel — get one from
// https://aistudio.google.com/app/apikey and add via `vercel env add`).
// Free tier covers 25-50 images per day depending on model.
//
// Body: { prompt, userId?, aspect? = 'portrait' | 'square' | 'landscape' }

import { put } from '@vercel/blob';
import { requireWebhookSecret } from '../lib/security.js';

const MODEL = 'imagen-4.0-generate-001';
const blobPrefix = (userId) => `thinkinbuddy/images/${userId}/`;

const ASPECT_TO_RATIO = {
  square:    '1:1',
  portrait:  '9:16',
  landscape: '16:9',
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireWebhookSecret(req, res)) return;

  const prompt = req.body?.prompt || req.query?.prompt;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const userId = req.body?.userId || req.query?.userId || 'anonymous';
  const aspect = (req.body?.aspect || 'portrait').toLowerCase();
  const ratio = ASPECT_TO_RATIO[aspect] || ASPECT_TO_RATIO.portrait;

  const apiKey = process.env.GOOGLE_API_KEY;
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!apiKey)    return res.status(500).json({ result: 'GOOGLE_API_KEY not configured (get from https://aistudio.google.com/app/apikey)' });
  if (!blobToken) return res.status(500).json({ result: 'BLOB_READ_WRITE_TOKEN not configured' });

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:predict?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: {
            sampleCount: 1,
            aspectRatio: ratio,
          },
        }),
      },
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err?.error?.message || `Google ${response.status}`;
      console.error('[image-imagen] error:', msg);
      return res.status(502).json({ result: `Imagen failed: ${msg}` });
    }

    const data = await response.json();
    const b64 = data?.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) return res.status(502).json({ result: 'Imagen returned no image data' });

    const buf = Buffer.from(b64, 'base64');
    const ts = Date.now();
    const key = `${blobPrefix(userId)}${ts}.png`;
    const blob = await put(key, buf, {
      access: 'public',
      contentType: 'image/png',
      addRandomSuffix: false,
      token: blobToken,
    });

    try {
      await put(
        `${blobPrefix(userId)}${ts}.meta.json`,
        JSON.stringify({ prompt, provider: 'imagen', ratio }),
        { access: 'public', contentType: 'application/json', addRandomSuffix: false, token: blobToken },
      );
    } catch (err) {
      console.error('[image-imagen] sidecar write failed (non-fatal):', err?.message || err);
    }

    return res.status(200).json({
      result: 'Image generated.',
      url: blob.url,
      prompt,
      provider: 'imagen',
    });
  } catch (err) {
    console.error('[image-imagen] error:', err?.message || err);
    return res.status(502).json({ result: `Imagen error: ${err?.message || 'unknown'}` });
  }
}
