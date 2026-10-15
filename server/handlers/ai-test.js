// POST /api/ai-test — one-token probe for Settings → Your AI "Test" button.
// Body: { provider?: 'gemini'|'openai'|'anthropic'|'xai' }
// Uses the caller's X-User-Key-* headers (and X-User-Brain / X-User-Model).

import { completeText, preferredBrain, hasTextLlm } from '../../lib/llm.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Brain, X-User-Model, X-User-Key-OPENAI, X-User-Key-ANTHROPIC, X-User-Key-XAI, X-User-Key-GEMINI');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const provider = (req.body?.provider || preferredBrain(req) || 'gemini').toLowerCase();
  if (!hasTextLlm(req) && provider !== 'gemini') {
    return res.status(400).json({ ok: false, error: 'Paste a key first, or pick Free (Gemini).' });
  }

  try {
    const text = await completeText({
      req,
      provider,
      maxTokens: 16,
      system: 'Reply with exactly: OK',
      user: 'ping',
    });
    return res.status(200).json({ ok: true, provider, reply: String(text).slice(0, 80) });
  } catch (e) {
    return res.status(200).json({ ok: false, provider, error: String(e?.message || e).slice(0, 300) });
  }
}
