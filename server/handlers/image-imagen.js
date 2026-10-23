// api/image-imagen.js — Google Imagen image generation for ThinkinBuddy.
//
// Uses GOOGLE_API_KEY (NOT YET SET on Vercel — get one from
// https://aistudio.google.com/app/apikey and add via `vercel env add`).
// Free tier covers 25-50 images per day depending on model.
//
// Body: { prompt, userId?, aspect? = 'portrait' | 'square' | 'landscape' }

import { put } from '@vercel/blob';
import { requireWebhookSecret } from '../../lib/security.js';
import { isAllowed, SAFE_REFUSAL } from '../../lib/moderation.js';
import { getKey, resolveKey } from '../../lib/userKeys.js';
import { resolveHandlerTenant } from '../../lib/tenant.js';
import { costFor, meterGate, denyMetering, recordMetered, getUsageDb } from '../../lib/usage.js';
import { randomUUID } from 'node:crypto';
import { safetyDecision, safetyInputsFromRequest } from '../../lib/safety.js';

const MODEL = 'imagen-4.0-generate-001';
const blobPrefix = (userId) => `thinkinbuddy/images/${userId}/`;

// Imagen is usually fast, but raise the ceiling so a slow gen never 504s.
export const config = { maxDuration: 120 };

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

  const { key: apiKey, source: keySource } = resolveKey(req, 'GOOGLE_API_KEY');
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!apiKey)    return res.status(500).json({ result: 'GOOGLE_API_KEY not configured (get from https://aistudio.google.com/app/apikey)' });
  if (!blobToken) return res.status(500).json({ result: 'BLOB_READ_WRITE_TOKEN not configured' });

  // Kid-safe gate: moderate the prompt via OpenAI BEFORE calling Imagen.
  const { failClosed } = safetyDecision(safetyInputsFromRequest(req));
  const mod = await isAllowed(prompt, getKey(req, 'OPENAI_API_KEY'), { failClosed });
  if (!mod.allowed) {
    console.warn('[image-imagen] prompt blocked by moderation:', mod.reason);
    return res.status(200).json({ result: SAFE_REFUSAL });
  }


  // Usage metering (hosted model, lib/usage.js): enforced mode + our
  // server key -> the tenant's bucket must cover the estimate BEFORE
  // the provider call (402 credits_exhausted, no provider call made).
  // Compat mode and BYO user keys skip metering entirely — see
  // shouldMeter in lib/usage.js.
  const imagenReqId = randomUUID();
  const imagenEst = costFor('image');
  const imagenGate = await meterGate({ db: getUsageDb, tenantId: resolvedTenant.tenantId, keySource: keySource, estCredits: imagenEst });
  if (!imagenGate.allowed) return denyMetering(res, imagenGate);

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

    await recordMetered(imagenGate, getUsageDb, {
      tenantId: resolvedTenant.tenantId, provider: 'google', action: 'image',
      units: 1, credits: imagenEst, requestId: imagenReqId,
    });

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
