// api/image.js — DALL-E 3 image generation for ThinkinBuddy.
// Simplified: returns OpenAI URL directly (valid 1 hour), no blob storage needed.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const prompt = req.body?.prompt || req.query?.prompt;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  try {
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
        size: '1024x1024',
        style: 'vivid',
        response_format: 'url',
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('[image] OpenAI error:', err?.error?.message);
      return res.status(200).json({ result: `Image generation failed: ${err?.error?.message || 'unknown'}` });
    }

    const data = await response.json();
    const url = data.data?.[0]?.url;
    if (!url) return res.status(200).json({ result: 'No image returned from OpenAI' });

    // Store latest image URL in a simple global cache for the polling endpoint
    global.__latestImage = { url, prompt, timestamp: Date.now() };

    return res.status(200).json({ result: 'Image generated.', url, prompt });
  } catch (err) {
    console.error('[image] error:', err?.message || err);
    return res.status(200).json({ result: `Image generation error: ${err?.message || 'unknown'}` });
  }
}
