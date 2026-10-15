// lib/llm.js — shared text completion for server handlers.
// Prefers free Gemini (Google AI Studio) when GEMINI_API_KEY or
// GOOGLE_GENAI_API_KEY is set; falls back to Anthropic if present.
// Never logs the key.

const GEMINI_MODEL = process.env.LLM_GEMINI_MODEL || 'gemini-3.5-flash-lite';
const ANTHROPIC_MODEL = process.env.LLM_ANTHROPIC_MODEL || 'claude-haiku-4-5';

export function geminiKey(env = process.env) {
  for (const n of ['GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY']) {
    const v = env[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export function anthropicKey(env = process.env) {
  const v = env.ANTHROPIC_API_KEY;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** True when at least one free/paid text LLM key is configured. */
export function hasTextLlm(env = process.env) {
  return Boolean(geminiKey(env) || anthropicKey(env));
}

/**
 * Complete a system+user prompt. Returns plain text.
 * @param {{ system?: string, user: string, maxTokens?: number }} opts
 */
export async function completeText({ system = '', user, maxTokens = 512 }) {
  if (!user || typeof user !== 'string') throw new Error('completeText: user required');
  const g = geminiKey();
  if (g) return geminiComplete(g, system, user, maxTokens);
  const a = anthropicKey();
  if (a) return anthropicComplete(a, system, user, maxTokens);
  throw new Error('No LLM key: set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY');
}

async function geminiComplete(key, system, user, maxTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || JSON.stringify(data).slice(0, 200);
    throw new Error(`Gemini ${r.status}: ${msg}`);
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini returned empty text');
  return text;
}

async function anthropicComplete(key, system, user, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: user }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`Anthropic ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data?.content?.[0]?.text || '';
}

/**
 * DuckDuckGo HTML search — no API key. Returns [{title, url, snippet}].
 * Used so search_web works without Anthropic's paid web_search tool.
 */
export async function duckDuckGoSearch(query, { limit = 5 } = {}) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'ThinkinBuddy/1.0 (+https://thinkbuddy-sandy.vercel.app)',
      Accept: 'text/html',
    },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`DuckDuckGo ${r.status}`);
  const html = await r.text();
  return parseDuckDuckGoHtml(html, limit);
}

export function parseDuckDuckGoHtml(html, limit = 5) {
  const out = [];
  const blocks = html.includes('result__a')
    ? html.split(/(?=<[^>]*class="[^"]*result__a)/i).slice(1)
    : [html];
  for (const block of blocks) {
    if (out.length >= limit) break;
    const am = block.match(/class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!am) continue;
    const href = decodeDuckRedirect(am[1]);
    const title = stripTags(am[2]).trim();
    if (!title || !href) continue;
    if (/^https?:\/\/([a-z0-9.-]*\.)?duckduckgo\.com/i.test(href)) continue;
    const sm = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)>/i);
    out.push({ title, url: href, snippet: stripTags(sm?.[1] || '').trim() });
  }
  return out;
}

function decodeDuckRedirect(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return u.href;
  } catch {
    return href;
  }
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/\s{2,}/g, ' ');
}
