// api/image.js — image generation for ThinkinBuddy.
//
// OpenAI deprecated dall-e-3 on this account; the live model is gpt-image-2,
// which returns base64 instead of a URL. We upload the bytes to Vercel Blob
// so the widget can display the image with a plain <img src>, and so the
// /api/latest-image poller can find the most recent one across serverless
// instances (replaces the broken in-memory global).

import { put } from '@vercel/blob';
import { requireWebhookSecret } from '../../lib/security.js';
import { isAllowed, SAFE_REFUSAL } from '../../lib/moderation.js';
import { getKey } from '../../lib/userKeys.js';
import { safetyDecision, safetyInputsFromRequest } from '../../lib/safety.js';
import { saveMediaMemory } from '../../lib/mediaMemory.js';

const MODEL = 'gpt-image-2';
const blobPrefix = (userId) => `thinkinbuddy/images/${userId}/`;

export default async function handler(req, res) {
  // Shared-secret gate. This endpoint is invoked server-to-server by the
  // ElevenLabs agent as a tool webhook — no browser, so Origin/CORS is
  // the wrong gate. The agent config must send X-Webhook-Secret matching
  // the WEBHOOK_SECRET env var. No header reflection / no CORS — calling
  // this from a browser was never supported anyway.
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireWebhookSecret(req, res)) return;

  const prompt = req.body?.prompt || req.query?.prompt;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const userId = req.body?.userId || req.query?.userId || 'anonymous';

  // Aspect: default = portrait phone fill (the widget displays full-screen on
  // mobile). User / agent can override via body.aspect = 'square' | 'portrait'
  // | 'landscape', or via raw body.size = '1024x1024' | '1024x1536' | '1536x1024'.
  // 1024x1536 is the closest portrait OpenAI offers to a phone aspect (2:3).
  const ASPECT_TO_SIZE = {
    square:    '1024x1024',
    portrait:  '1024x1536',
    landscape: '1536x1024',
  };
  const VALID_SIZES = new Set(Object.values(ASPECT_TO_SIZE));
  let size = '1024x1536'; // default = portrait phone fill
  const rawSize = req.body?.size || req.query?.size;
  const rawAspect = (req.body?.aspect || req.query?.aspect || '').toLowerCase();
  if (rawSize && VALID_SIZES.has(rawSize)) size = rawSize;
  else if (ASPECT_TO_SIZE[rawAspect]) size = ASPECT_TO_SIZE[rawAspect];

  const apiKey = getKey(req, 'OPENAI_API_KEY');
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!apiKey)    return res.status(500).json({ result: 'OPENAI_API_KEY not configured' });
  if (!blobToken) return res.status(500).json({ result: 'BLOB_READ_WRITE_TOKEN not configured' });

  // Kid-safe gate: moderate the prompt BEFORE spending a provider call.
  const { failClosed } = safetyDecision(safetyInputsFromRequest(req));
  const mod = await isAllowed(prompt, apiKey, { failClosed });
  if (!mod.allowed) {
    console.warn('[image] prompt blocked by moderation:', mod.reason);
    return res.status(200).json({ result: SAFE_REFUSAL });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        n: 1,
        size,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err?.error?.message || `OpenAI ${response.status}`;
      console.error('[image] OpenAI error:', msg);
      // Tools get a speakable failure string; status reflects the real failure.
      return res.status(502).json({ result: `Image generation failed: ${msg}` });
    }

    const data = await response.json();
    const b64 = data?.data?.[0]?.b64_json;
    const url = data?.data?.[0]?.url; // unlikely on gpt-image-* but cheap to support

    let publicUrl;
    if (url) {
      publicUrl = url;
    } else if (b64) {
      const buf = Buffer.from(b64, 'base64');
      const ts = Date.now();
      const key = `${blobPrefix(userId)}${ts}.png`;
      const blob = await put(key, buf, {
        access: 'public',
        contentType: 'image/png',
        addRandomSuffix: false,
        token: blobToken,
      });
      publicUrl = blob.url;
      // Sidecar so /api/latest-image can return the original prompt as caption.
      try {
        await put(
          `${blobPrefix(userId)}${ts}.meta.json`,
          JSON.stringify({ prompt }),
          { access: 'public', contentType: 'application/json', addRandomSuffix: false, token: blobToken }
        );
      } catch (err) {
        console.error('[image] sidecar write failed (non-fatal):', err?.message || err);
      }
      // Persist to Neon memory so this image is recallable by semantic search.
      saveMediaMemory({ userId, type: 'image', blobUrl: publicUrl, prompt, createdAt: ts }).catch(
        (e) => console.error('[image] saveMediaMemory failed (non-fatal):', e?.message || e)
      );
    } else {
      return res.status(502).json({ result: 'OpenAI returned no image data' });
    }

    // Tool-call response: ElevenLabs reads `result` and speaks it; the widget
    // separately polls /api/latest-image and shows the picture once it lands.
    return res.status(200).json({
      result: 'Image generated.',
      url: publicUrl,
      prompt,
    });
  } catch (err) {
    console.error('[image] error:', err?.message || err);
    return res.status(502).json({ result: `Image generation error: ${err?.message || 'unknown'}` });
  }
}
