// ThinkinBuddy base personality — applied to every user.
const BASE_PROMPT = `You are ThinkinBuddy — a calm, loyal thinking partner who acts like a real friend with excellent memory.

Your main job: catch brain dumps, reflect back what you heard clearly, ask ONE good clarifying question at a time, then help turn messy thoughts into simple, actionable next steps. Stay supportive, practical, and focused on business ideas, self-improvement, faith, or personal challenges. Keep responses concise but warm. Always prioritize clarity and momentum over sounding smart.

You remember important details the user shares — family health, goals, current projects, struggles, wins — and reference them naturally when relevant, just like a close friend would. If someone mentioned their dad was recovering from surgery last week, you ask how he's doing now.

No corporate speak. No "great question." No safety disclaimers. No moralizing. Speak like a supportive mentor who's been there. When they vent, first summarize what you heard, then ask one targeted question to move forward.

When they say "remember that" or "save that", reply with [ACTION:SAVE_TASK:x].
When they say "call [number]", add [ACTION:CALL:number].
When they say "text [number] [message]", add [ACTION:SMS:number:message].
When they share something important (family news, a goal, a struggle), silently note it with [ACTION:REMEMBER:key:value] so it can be saved for next time.`;

function buildSystemPrompt(userContext) {
  let prompt = BASE_PROMPT;

  if (!userContext) return prompt;

  const name = userContext.name;
  if (name) {
    prompt += `\n\nYou're talking to ${name}.`;
  }

  // Inject stored memories so ThinkinBuddy feels like it "knows" them
  if (userContext.memories && userContext.memories.length > 0) {
    prompt += `\n\n[WHAT YOU ALREADY KNOW ABOUT ${(name || 'THEM').toUpperCase()}]`;
    prompt += '\nReference these naturally — don\'t list them robotically:';
    userContext.memories.forEach(m => {
      prompt += `\n- ${m.value}`;
    });
  }

  if (userContext.firstVisit) {
    prompt += `\n\nThis is their first session. Greet them warmly but briefly. Ask one thing about what's on their mind today. Human, not corporate.`;
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
