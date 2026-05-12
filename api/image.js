// api/image.js — DALL-E 3 image generation for ThinkinBuddy.
//
// Called by the ElevenLabs agent when the user asks for an image.
// Generates via DALL-E 3, stores result in Vercel Blob so the UI can display it.
//
// POST body: { prompt: string, style?: "natural" | "vivid", size?: "1024x1024" | "1792x1024" | "1024x1792" }
// GET  param: ?prompt=...
// Response: { url: string, blobUrl: string }

import { put } from '@vercel/blob';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const prompt = req.body?.prompt || req.query?.prompt;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const style = req.body?.style || req.query?.style || 'vivid';
  const size = req.body?.size || req.query?.size || '1024x1024';

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  try {
    // Generate image with DALL-E 3
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size,
        style,
        response_format: 'url',
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(200).json({
        error: true,
        result: `Image generation failed: ${err?.error?.message || 'unknown error'}`,
      });
    }

    const data = await response.json();
    const imageUrl = data.data?.[0]?.url;
    if (!imageUrl) return res.status(200).json({ error: true, result: 'No image returned' });

    // Fetch and store in Vercel Blob so it persists (OpenAI URLs expire in 1 hour)
    const imageRes = await fetch(imageUrl);
    const imageBuffer = await imageRes.arrayBuffer();
    const blob = await put(
      `thinkinbuddy/images/${Date.now()}.png`,
      Buffer.from(imageBuffer),
      { access: 'public', contentType: 'image/png', addRandomSuffix: false }
    );

    // Write latest image pointer so the page can poll for it
    await put(
      'thinkinbuddy/latest-image.json',
      JSON.stringify({ url: blob.url, prompt, timestamp: Date.now() }),
      { access: 'public', contentType: 'application/json', addRandomSuffix: false }
    );

    return res.status(200).json({
      result: `Image generated successfully.`,
      url: blob.url,
      prompt,
    });
  } catch (err) {
    console.error('[image] error:', err);
    return res.status(200).json({ result: 'Image generation failed. Try again in a moment.' });
  }
}
