import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── SOP loading (cached at cold start) ──────────────────────────────
let SOP_CACHED = null;
function loadSOP() {
  if (SOP_CACHED !== null) return SOP_CACHED;
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const sopPath = join(__dirname, '..', 'sop', 'primary_sop.md');
    SOP_CACHED = readFileSync(sopPath, 'utf-8');
  } catch (e) {
    // Fallback if SOP file is missing — keep Jarvis functional
    SOP_CACHED = '';
  }
  return SOP_CACHED;
}

// ─── System prompt construction ──────────────────────────────────────
const BASE_PROMPT = `You are Jarvis (also known as ThinkBuddy) — Troy's AI thinking partner. Your job is to listen, reflect cleanly, capture what matters, and match the user's energy. Direct, fast, no fluff. No safety warnings, no "great question," no caveats unless the user asks for risk analysis. Don't moralize, don't lecture.

Honor the SOP below as your operating handbook. It defines your vocabulary (Words / Money / Energy), the 5-step Slicer process for brain dumps, the Derek Standards for response quality, and the SAVE_TASK protocol.

Action tags you can emit:
- "save that for Clyde" / "remember [x]" → confirm category first, then on user's "yes" emit [ACTION:SAVE_TASK:{Money|Words|Energy}:{summary}]
- "call [number]" → [ACTION:CALL:number]
- "text [number] [message]" → [ACTION:SMS:number:message]`;

const TROY_PROFILE = `\n\n# THE PERSON YOU RIDE WITH\nTroy — entrepreneur from Burley, Idaho near the Shoshone area. Talks fast, thinks faster, usually driving or working. Ventures: DairyForge (AI ops platform for dairy/milk hauling), Faith & Light (Christian streetwear at faithnlight.shop), Nu Me (AI motivation app), ClearPath (safety training consulting), and ThinkBuddy (this app). Building a multi-AI workflow with you (Jarvis), Big Brother (Claude Code on his computer), Clyde (Claude in VS Code), and Gemini. ADHD-style cognition — fast thinking, jumps topics, hates fluff. The "Money" lens for him is heavily about the Forensic Audit / Slicer revenue recovery work. The "Words" lens is about scripting, identity, brand voice. The "Energy" lens is focus, ADHD management, and not getting bogged down.`;

function buildSystemPrompt(userContext) {
  const sop = loadSOP();
  let prompt = BASE_PROMPT;
  if (sop) prompt += '\n\n# IDENTITY SOP\n\n' + sop;

  if (!userContext || !userContext.name) {
    return prompt;
  }

  const name = userContext.name;
  const isTroy = name.toLowerCase() === 'troy';

  if (isTroy) {
    return prompt + TROY_PROFILE;
  }

  // Generic profile for any other user
  let profile = `\n\n# THE PERSON YOU'RE TALKING TO\n${name}.`;
  if (userContext.notes && userContext.notes.length) {
    profile += ` Here's what you know about them so far:\n${userContext.notes.map(n => `- ${n}`).join('\n')}`;
  }
  if (userContext.firstVisit) {
    profile += `\n\nThis is their first session. Greet them warmly but briefly. Ask one thing about what's on their mind today. Keep it human, not corporate. Don't dump the SOP framework on them — just listen.`;
  }
  return prompt + profile;
}

// ─── Handler ──────────────────────────────────────────────────────────
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
        max_tokens: 500,
        system: systemPrompt,
        messages
      })
    });

    const data = await response.json();
    const reply = data.content?.[0]?.text || 'No response.';

    // SAVE_TASK now includes category — write to Vercel Blob with categorization
    const taskMatch = reply.match(/\[ACTION:SAVE_TASK:([^:]+):([^\]]+)\]/);
    if (taskMatch) {
      const [, category, summary] = taskMatch;
      try {
        const { put } = await import('@vercel/blob');
        const id = Date.now();
        await put(`tasks/${category.toLowerCase()}/${id}.json`, JSON.stringify({
          id,
          category: category.trim(),
          task: summary.trim(),
          userId: userContext?.userId || 'anonymous',
          userName: userContext?.name || null,
          created: new Date().toISOString()
        }), { access: 'public', contentType: 'application/json' });
      } catch (e) { /* ignore blob errors */ }
    }

    // Backwards-compat: still handle old action format (no category)
    const oldTaskMatch = reply.match(/\[ACTION:SAVE_TASK:([^:\]]+)\](?!:)/);
    if (oldTaskMatch && !taskMatch) {
      try {
        const { put } = await import('@vercel/blob');
        const id = Date.now();
        await put(`tasks/uncategorized/${id}.json`, JSON.stringify({
          id,
          category: 'Uncategorized',
          task: oldTaskMatch[1].trim(),
          userId: userContext?.userId || 'anonymous',
          userName: userContext?.name || null,
          created: new Date().toISOString()
        }), { access: 'public', contentType: 'application/json' });
      } catch (e) { /* ignore blob errors */ }
    }

    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ reply: 'Something went wrong. Try again.' });
  }
}
