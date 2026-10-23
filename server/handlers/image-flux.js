// api/image-flux.js — Black Forest Labs FLUX image generation via Replicate.
//
// Uses REPLICATE_API_TOKEN (NOT YET SET on Vercel — get one from
// https://replicate.com/account/api-tokens and add via `vercel env add`).
// Cheapest provider: FLUX.1 schnell ~$0.003/image, dev ~$0.025, pro ~$0.055.
//
// Body: { prompt, userId?, aspect? = 'portrait' | 'square' | 'landscape', quality? = 'fast' | 'dev' | 'pro' }

import { put } from '@vercel/blob';
import { requireWebhookSecret } from '../../lib/security.js';
import { isAllowed, SAFE_REFUSAL } from '../../lib/moderation.js';
import { getKey } from '../../lib/userKeys.js';
import { safetyDecision, safetyInputsFromRequest } from '../../lib/safety.js';

// Replicate model slugs for the three FLUX tiers.
// Mark's voice spec 2026-06-02: pro = flux-2-pro (latest). Keeping schnell/dev
// on Flux 1.x because the v2 schnell/dev variants aren't on Replicate yet.
const QUALITY_TO_MODEL = {
  fast: 'black-forest-labs/flux-schnell',
  dev:  'black-forest-labs/flux-dev',
  pro:  'black-forest-labs/flux-2-pro',
};

const ASPECT_TO_RATIO = {
  square:    '1:1',
  portrait:  '9:16',
  landscape: '16:9',
};

const blobPrefix = (userId) => `thinkinbuddy/images/${userId}/`;

// FLUX dev/pro can take ~60s; raise the ceiling so it never 504s mid-gen.
export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireWebhookSecret(req, res)) return;

  const prompt = req.body?.prompt || req.query?.prompt;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const userId = req.body?.userId || req.query?.userId || 'anonymous';
  const aspect = (req.body?.aspect || 'portrait').toLowerCase();
  const aspect_ratio = ASPECT_TO_RATIO[aspect] || ASPECT_TO_RATIO.portrait;
  const quality = (req.body?.quality || 'fast').toLowerCase();
  const model = QUALITY_TO_MODEL[quality] || QUALITY_TO_MODEL.fast;

  const apiKey = process.env.REPLICATE_API_TOKEN;
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!apiKey)    return res.status(500).json({ result: 'REPLICATE_API_TOKEN not configured (get from https://replicate.com/account/api-tokens)' });
  if (!blobToken) return res.status(500).json({ result: 'BLOB_READ_WRITE_TOKEN not configured' });

  // Kid-safe gate: moderate the prompt via OpenAI BEFORE calling Replicate/FLUX.
  const { failClosed } = safetyDecision(safetyInputsFromRequest(req));
  const mod = await isAllowed(prompt, getKey(req, 'OPENAI_API_KEY'), { failClosed });
  if (!mod.allowed) {
    console.warn('[image-flux] prompt blocked by moderation:', mod.reason);
    return res.status(200).json({ result: SAFE_REFUSAL });
  }

  try {
    // Replicate uses model-versioned predictions; the "models" path resolves the
    // latest stable version automatically.
    const startRes = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait', // Replicate's blocking mode — waits up to 60s for completion
      },
      body: JSON.stringify({
        input: {
          prompt,
          aspect_ratio,
          output_format: 'png',
          num_outputs: 1,
        },
      }),
    });

    if (!startRes.ok) {
      const err = await startRes.json().catch(() => ({}));
      const msg = err?.detail || err?.error || `Replicate ${startRes.status}`;
      console.error('[image-flux] start failed:', msg);
      return res.status(502).json({ result: `FLUX failed: ${msg}` });
    }

    let pred = await startRes.json();
    let status = pred?.status || 'starting';

    // If the blocking 'wait' didn't finish in 60s, fall back to polling.
    if (status !== 'succeeded' && status !== 'failed') {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline && status !== 'succeeded' && status !== 'failed') {
        await new Promise((r) => setTimeout(r, 2000));
        const poll = await fetch(pred?.urls?.get, {
          headers: { Authorization: `Token ${apiKey}` },
        });
        if (!poll.ok) break;
        pred = await poll.json();
        status = pred?.status || status;
      }
    }

    if (status !== 'succeeded') {
      return res.status(504).json({ result: `FLUX ended in ${status}` });
    }

    // FLUX output is an array of image URLs.
    const outputUrl = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    if (!outputUrl) return res.status(502).json({ result: 'FLUX returned no image' });

    const dl = await fetch(outputUrl);
    if (!dl.ok) return res.status(502).json({ result: 'FLUX content download failed' });
    const buf = Buffer.from(await dl.arrayBuffer());
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
        JSON.stringify({ prompt, provider: 'flux', quality, aspect_ratio }),
        { access: 'public', contentType: 'application/json', addRandomSuffix: false, token: blobToken },
      );
    } catch (err) {
      console.error('[image-flux] sidecar write failed (non-fatal):', err?.message || err);
    }

    return res.status(200).json({
      result: 'Image generated.',
      url: blob.url,
      prompt,
      provider: 'flux',
      quality,
    });
  } catch (err) {
    console.error('[image-flux] error:', err?.message || err);
    return res.status(502).json({ result: `FLUX error: ${err?.message || 'unknown'}` });
  }
}
