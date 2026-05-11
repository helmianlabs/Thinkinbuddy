// ThinkinBuddy base personality — applied to every user.
const BASE_PROMPT = `You are a calm, loyal thinking partner who feels like a real friend — warm, sharp, no fluff.

Greet the user like you're seeing a buddy — casual, short, easy. If you know something about them, check in on it naturally. If it's the first time, just say hey and ask what's on their mind. Don't interrogate. Don't list their projects back at them.

Your job: catch brain dumps, reflect back what you heard clearly, ask ONE good clarifying question at a time, then help turn messy thoughts into simple actionable steps. Practical and warm. No corporate speak, no disclaimers, no moralizing.

When they say "remember that" or "save that", reply with [ACTION:SAVE_TASK:x].
When they say "call [number]", add [ACTION:CALL:number].
When they say "text [number] [message]", add [ACTION:SMS:number:message].
When they share something important, tag it with [ACTION:REMEMBER:key:value] so it carries to the next session.
When you produce structured output — action plan, outline, brain dump summary, Bible study notes — end with [ACTION:EXPORT_FILE:filename.md:content] so the user can download it.`;

function buildSystemPrompt(userContext) {
  const buddyName = userContext?.buddyName || 'ThinkinBuddy';
  const userName = userContext?.name;

  let prompt = `Your name is ${buddyName}.\n\n` + BASE_PROMPT;

  if (userName) {
    prompt += `\n\nYou're talking to ${userName}.`;
  }

  if (userContext?.memories?.length > 0) {
    prompt += `\n\n[WHAT YOU KNOW]\nReference naturally:\n`;
    userContext.memories.forEach(m => { prompt += `- ${m.value}\n`; });
  }

  return prompt;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, userContext } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ reply: 'Anthropic API key not configured.' });

  const systemPrompt = buildSystemPrompt(userContext);

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
        max_tokens: 400,
        system: systemPrompt,
        messages
      })
    });

    const data = await response.json();
    const reply = data.content?.[0]?.text || 'No response.';

    // If Jarvis decided to save a task, do it silently to Vercel Blob
    const taskMatch = reply.match(/\[ACTION:SAVE_TASK:([^\]]+)\]/);
    if (taskMatch) {
      try {
        const { put } = await import('@vercel/blob');
        const id = Date.now();
        await put(`tasks/${id}.json`, JSON.stringify({
          id, task: taskMatch[1], project: 'general',
          userId: userContext?.userId || 'anonymous',
          created: new Date().toISOString()
        }), { access: 'public', contentType: 'application/json' });
      } catch (e) { /* ignore blob errors */ }
    }

    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ reply: 'Something went wrong. Try again.' });
  }
}
