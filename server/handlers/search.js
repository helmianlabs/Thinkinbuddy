// api/search.js — web search tool endpoint for ThinkinBuddy.
//
// Called by the ElevenLabs agent when it needs current information.
// Uses Claude's built-in web_search tool to fetch and synthesize results.
// Returns a plain-text summary the agent reads back to the user.
//
// POST body: { query: string }
// Response:  { result: string }
//
// Kid-safe: refuses obviously-unsafe queries (Layer 3 token list) and runs the
// query through OpenAI moderation (Layer 2) before searching. Instructs the
// model to keep results safe-search/kid-appropriate.

import { isSafeQuery, UNSAFE_QUERY_MSG } from '../../lib/safeBrowse.js';
import { isAllowed } from '../../lib/moderation.js';
import { requireToolAuth } from '../../lib/security.js';
import { completeText, duckDuckGoSearch, hasTextLlm } from '../../lib/llm.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Spends OPENAI_API_KEY (moderation, optional) then GEMINI/Anthropic on
  // every call, and had no gate of any kind: `POST {}` from anywhere on the
  // internet returned 400 "query required", i.e. it reached parameter
  // validation with nothing standing in front of it. Gate goes here, ahead of
  // both provider calls, so an unauthorized caller costs nothing.
  //
  // NO-OP UNTIL ENFORCE_TOOL_AUTH=1 — see lib/security.js:requireToolAuth.
  // The only caller is the agent's search_web tool, which does not send the
  // header yet. Read that comment before assuming this endpoint is closed.
  if (!requireToolAuth(req, res)) return;

  // Accept query from body (POST JSON) or URL query string (ElevenLabs webhook)
  const query = req.body?.query || req.query?.query;
  if (!query) return res.status(400).json({ error: 'query required' });

  // Layer 3 — fast obvious-unsafe token catch.
  const qSafe = isSafeQuery(query);
  if (!qSafe.safe) {
    console.warn('[search] blocked unsafe query (token):', qSafe.reason);
    return res.status(200).json({ result: UNSAFE_QUERY_MSG });
  }
  // Layer 2 — semantic moderation of the query.
  const qMod = await isAllowed(query, process.env.OPENAI_API_KEY);
  if (!qMod.allowed) {
    console.warn('[search] blocked unsafe query (moderation):', qMod.reason);
    return res.status(200).json({ result: UNSAFE_QUERY_MSG });
  }

  if (!hasTextLlm(req)) {
    return res.status(500).json({ error: 'No LLM key. Use Free Gemini on the server, or add a key under Settings → Your AI.' });
  }

  try {
    // Free path: DuckDuckGo results + Gemini/Anthropic summarize.
    // (Anthropic web_search tool needs a paid Anthropic key; we avoid it.)
    let hits = [];
    try {
      hits = await duckDuckGoSearch(query, { limit: 5 });
    } catch (e) {
      console.error('[search] duckduckgo failed:', e?.message || e);
    }
    const digest = hits.length
      ? hits.map((h, i) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet}`).join('\n\n')
      : '(no web hits — answer from general knowledge if safe, else say you could not find a kid-appropriate answer)';
    const result = await completeText({
      req,
      maxTokens: 512,
      system: 'You are a research assistant for a kids and family app (ages 11+). Treat every search as safe-search ON: never surface, link, describe, or summarize adult, sexual, violent, self-harm, or other content inappropriate for children. If the only relevant results are unsafe, say you could not find a kid-appropriate answer instead. Return a concise, conversational summary of the most relevant and current information. 2-4 sentences max. No bullet points — this will be read aloud.',
      user: `Search query: ${query}\n\nWeb results:\n${digest}`,
    });

    return res.status(200).json({ result: result.trim() || 'I searched but could not find a clear answer on that right now.' });
  } catch (err) {
    console.error('[search] error:', err);
    return res.status(500).json({ result: 'Search failed — try again in a moment.' });
  }
}
