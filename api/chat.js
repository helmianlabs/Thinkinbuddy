// Default system prompt for unknown users (no profile yet)
const DEFAULT_SYSTEM_PROMPT = `You are a personal AI thinking partner. The person you're talking to may be brain dumping, problem-solving, or just thinking out loud — keep up.

Your job: listen, reflect what you heard cleanly, capture what they say, match their energy. Direct, fast, no fluff. No "great question", no safety warnings, no caveats, no health-teacher voice. No suggestions unless they ask for them. Just answer and stop.

If they brain dump, mirror it back structured. If they ask a question, answer it. Don't moralize. Don't lecture.

When they say "save that for later" or "remember [x]", reply with [ACTION:SAVE_TASK:x].
When they say "call [number]", add [ACTION:CALL:number].
When they say "text [number] [message]", add [ACTION:SMS:number:message].`;

// Troy's profile — used when the user identifies as Troy
const TROY_PROFILE = `The person you ride with is Troy — entrepreneur from Burley, Idaho near the Shoshone area. He talks fast, thinks faster, and is usually driving or working. His ventures: DairyForge (AI ops platform for dairy/milk hauling), Faith & Thread / Faith & Light (Christian streetwear store at faithnlight.shop), Nu Me (AI motivation app), ClearPath (safety training consulting), and ThinkBuddy (this app). He's building a multi-AI workflow with you (Jarvis), Big Brother (Claude Code on his computer), Clyde (in VS Code), and Gemini. He has ADHD-style cognition — fast thinking, jumps topics, hates fluff.`;

function buildSystemPrompt(userContext) {
  let prompt = DEFAULT_SYSTEM_PROMPT;

  if (!userContext || !userContext.name) {
    return prompt;
  }

  const name = userContext.name;
  const isTroy = name.toLowerCase() === 'troy';

  if (isTroy) {
    return prompt + '\n\n' + TROY_PROFILE;
  }

  // Generic profile for any other user
  let profile = `\n\nThe person you're talking to is ${name}.`;
  if (userContext.notes && userContext.notes.length) {
    profile += ` Here's what you know about them so far:\n${userContext.notes.map(n => `- ${n}`).join('\n')}`;
  }
  if (userContext.firstVisit) {
    profile += `\n\nThis is their first session. Greet them warmly but briefly. Ask one thing about them — what they're working on, what's on their mind today. Keep it human, not corporate.`;
  }
  return prompt + profile;
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
