// api/chat.js — text-chat fallback used by desktop.html.
//
// Personality comes from lib/personality.js — single source of truth.
// This path is text-only (no ElevenLabs voice, no real webhook tools), so
// we expose the [ACTION:*] tag protocol instead of the tool block.

import { buildSystemPrompt } from '../lib/personality.js';
import { applyBrowserCors } from '../lib/security.js';
import { isAllowed } from '../lib/moderation.js';

export default async function handler(req, res) {
  // Origin allowlist — replaces the previous `*` wildcard that let
  // anyone with the URL spend Troy's Anthropic credits.
  const originOk = applyBrowserCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(originOk ? 200 : 403).end();
  }
  if (!originOk) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, userContext, mode: rawMode } = req.body || {};
  const VALID_MODES = ['default', 'spanish_tutor', 'feynman_module1'];
  const mode = VALID_MODES.includes(rawMode) ? rawMode : 'default';
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ reply: 'Anthropic API key not configured.' });

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
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: systemPrompt,
        messages,
      }),
    });

    const data = await response.json();
    const reply = data.content?.[0]?.text || 'No response.';

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
