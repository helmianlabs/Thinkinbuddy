// api/chat.js — text-chat fallback used by desktop.html.
//
// Personality comes from lib/personality.js — single source of truth.
// This path is text-only (no ElevenLabs voice, no real webhook tools), so
// we expose the [ACTION:*] tag protocol instead of the tool block.

import { buildSystemPrompt } from '../../lib/personality.js';
import { applyBrowserCors, requireBrowserFetch } from '../../lib/security.js';
import { isAllowed } from '../../lib/moderation.js';
import { completeText, hasTextLlm } from '../../lib/llm.js';

// Payload ceilings. A single request cannot be made expensive: input tokens are
// what cost money here (max_tokens caps only the OUTPUT at 400), so an
// unbounded messages array is the cheap way to run up a bill on someone else's
// key. These are far above any real conversation from this UI.
const MAX_MESSAGES = 100;
const MAX_TOTAL_CHARS = 100_000; // ~25k tokens of input

function totalChars(messages) {
  let n = 0;
  for (const m of messages) {
    const c = m?.content;
    if (typeof c === 'string') n += c.length;
    else if (Array.isArray(c)) for (const b of c) n += typeof b === 'string' ? b.length : (b?.text?.length || 0);
    if (n > MAX_TOTAL_CHARS) return n; // stop counting once over
  }
  return n;
}

export default async function handler(req, res) {
  // NOT AUTHENTICATION — see lib/security.js:requireBrowserFetch. This makes
  // the endpoint cost more to abuse; it does not make it safe. A caller who
  // sets Origin plus the three Sec-Fetch-* headers still gets in, and there is
  // no way to stop that without a real user credential, which this app has
  // none of. Do not mark /api/chat "secured" on the strength of this.
  //
  // Preflight must still answer on origin alone: a browser sends OPTIONS
  // WITHOUT Sec-Fetch-Mode: cors on the actual request semantics, and failing
  // the preflight would block the very browsers this is meant to keep working.
  const originOk = applyBrowserCors(req, res);
  if (req.method === 'OPTIONS') {
    return res.status(originOk ? 200 : 403).end();
  }
  if (!requireBrowserFetch(req, res)) return; // writes 403 itself
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, userContext, mode: rawMode } = req.body || {};
  const VALID_MODES = ['default', 'spanish_tutor', 'feynman_module1'];
  const mode = VALID_MODES.includes(rawMode) ? rawMode : 'default';
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  // Cap BEFORE the moderation call and the Anthropic call — both cost money.
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages must be an array' });
  }
  if (messages.length > MAX_MESSAGES) {
    return res.status(413).json({ error: `too many messages (max ${MAX_MESSAGES})` });
  }
  if (totalChars(messages) > MAX_TOTAL_CHARS) {
    return res.status(413).json({ error: `conversation too large (max ${MAX_TOTAL_CHARS} characters)` });
  }

  if (!hasTextLlm(req)) return res.status(500).json({ reply: 'No LLM key. Use Free Gemini, or add a key under Settings → Your AI.' });

  // Kid-safe gate: moderate the latest user message BEFORE calling Claude.
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastUserText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : Array.isArray(lastUser?.content)
      ? lastUser.content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join(' ')
      : '';
  const mod = await isAllowed(lastUserText, process.env.OPENAI_API_KEY);
  if (!mod.allowed) {
    console.warn('[chat] user message blocked by moderation:', mod.reason);
    return res.status(200).json({ reply: "Let's keep it friendly — I'm not going there. What else is on your mind?" });
  }

  const systemPrompt = buildSystemPrompt({
    buddyName: userContext?.buddyName,
    userName: userContext?.name,
    memories: userContext?.memories || [],
    includeToolsBlock: false,   // no webhook tools on this surface
    includeActionTags: true,    // text path uses ACTION tags as its "tools"
    mode,
  });

  try {
    const reply = (await completeText({
      req,
      maxTokens: 400,
      system: systemPrompt,
      user: messages.map((m) => {
        const role = m.role === 'assistant' ? 'Buddy' : 'User';
        const c = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join(' ')
            : '';
        return `${role}: ${c}`;
      }).join('\n\n'),
    })) || 'No response.';

    // If the buddy emitted [ACTION:SAVE_TASK:x], persist it silently.
    const taskMatch = reply.match(/\[ACTION:SAVE_TASK:([^\]]+)\]/);
    if (taskMatch) {
      try {
        const { put } = await import('@vercel/blob');
        const id = Date.now();
        await put(`tasks/${id}.json`, JSON.stringify({
          id,
          task: taskMatch[1],
          project: 'general',
          userId: userContext?.userId || 'anonymous',
          created: new Date().toISOString(),
        }), { access: 'public', contentType: 'application/json' });
      } catch (e) { /* ignore blob errors */ }
    }

    return res.status(200).json({ reply });
  } catch (e) {
    console.error('[chat] error:', e?.message || e);
    return res.status(500).json({ reply: 'Something went wrong. Try again.' });
  }
}
