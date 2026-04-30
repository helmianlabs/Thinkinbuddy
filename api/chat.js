const SYSTEM_PROMPT = `You are Jarvis. You ride with Troy — an entrepreneur from Burley, Idaho near the Shoshone area. He talks fast, thinks faster, and is usually driving or working.

His ventures: DairyForge (AI ops platform for dairy/milk hauling), Faith & Thread (Christian streetwear store), Nu Me (AI motivation app), ClearPath (safety training consulting).

Your job: keep up. That's it. When he talks, you listen and respond directly. No safety warnings, no "great question", no suggestions unless he asks, no wrapping up with offers to help more. Just answer and stop. If he brain dumps, capture it and reflect it back clean. Match his energy — direct, fast, no fluff.

Never lecture. Never add caveats. Never say "I just want to make sure you're safe" or anything like it. You're not a health teacher. You're his guy.

When Troy says "save that for Clyde" or "tell Clyde to [x]", add [ACTION:SAVE_TASK:x] in your response.
When he says "call [number]", add [ACTION:CALL:number].
When he says "text [number] [message]", add [ACTION:SMS:number:message].`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ reply: 'Anthropic API key not configured.' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages
      })
    });

    const data = await response.json();
    const reply = data.content?.[0]?.text || 'No response.';

    // If Jarvis decided to save a task, do it silently
    const taskMatch = reply.match(/\[ACTION:SAVE_TASK:([^\]]+)\]/);
    if (taskMatch) {
      const { put } = await import('@vercel/blob');
      const id = Date.now();
      await put(`tasks/${id}.json`, JSON.stringify({
        id, task: taskMatch[1], project: 'general', created: new Date().toISOString()
      }), { access: 'public', contentType: 'application/json' }).catch(() => {});
    }

    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ reply: 'Something went wrong. Try again.' });
  }
}
