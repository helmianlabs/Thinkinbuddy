// lib/llm.js — shared text completion for server handlers.
// Resolution order for each request:
//   1. User's chosen brain (X-User-Brain) + their key (X-User-Key-*) via userKeys
//   2. App free Gemini (GEMINI_API_KEY / GOOGLE_GENAI_API_KEY)
//   3. Other user-supplied keys (openai / anthropic / xai / gemini)
//   4. Env Anthropic fallback
// Never logs key values.

import { resolveKey } from './userKeys.js';

export const DEFAULT_MODELS = {
  gemini: process.env.LLM_GEMINI_MODEL || 'gemini-3.5-flash-lite',
  openai: process.env.LLM_OPENAI_MODEL || 'gpt-4.1-mini',
  anthropic: process.env.LLM_ANTHROPIC_MODEL || 'claude-haiku-4-5',
  xai: process.env.LLM_XAI_MODEL || 'grok-3-mini',
};

const ENV_FOR = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  xai: 'XAI_API_KEY',
};

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

function headerGet(req, name) {
  const headers = req?.headers || {};
  const want = name.toLowerCase();
  let v = headers[want];
  if (!v) {
    for (const [k, val] of Object.entries(headers)) {
      if (k.toLowerCase() === want) { v = val; break; }
    }
  }
  if (Array.isArray(v)) v = v[0];
  return typeof v === 'string' ? v.trim() : '';
}

/** Brain preferred by the client: gemini | openai | anthropic | xai */
export function preferredBrain(req) {
  const raw = (headerGet(req, 'x-user-brain') || 'gemini').toLowerCase();
  if (raw === 'claude') return 'anthropic';
  if (raw === 'grok') return 'xai';
  if (['gemini', 'openai', 'anthropic', 'xai'].includes(raw)) return raw;
  return 'gemini';
}

export function preferredModel(req, brain) {
  const m = headerGet(req, 'x-user-model');
  if (m) return m;
  return DEFAULT_MODELS[brain] || DEFAULT_MODELS.gemini;
}

/** Resolve a key for one provider: user header first, then env. */
export function keyForProvider(req, provider) {
  const envVar = ENV_FOR[provider];
  if (!envVar) return { key: null, source: 'none' };
  if (provider === 'gemini') {
    // userKeys looks at GEMINI_API_KEY; also accept GOOGLE_GENAI via env after
    const r = resolveKey(req, 'GEMINI_API_KEY');
    if (r.key) return r;
    const g = geminiKey();
    return g ? { key: g, source: 'env' } : { key: null, source: 'none' };
  }
  return resolveKey(req, envVar);
}

/** True when any usable path exists (env free Gemini, or a user key on this request). */
export function hasTextLlm(req, env = process.env) {
  if (geminiKey(env) || anthropicKey(env)) return true;
  if (!req) return false;
  for (const p of ['gemini', 'openai', 'anthropic', 'xai']) {
    if (keyForProvider(req, p).key) return true;
  }
  return false;
}

/**
 * @param {{ system?: string, user: string, maxTokens?: number, req?: object, provider?: string, model?: string }} opts
 */
export async function completeText({ system = '', user, maxTokens = 512, req, provider, model } = {}) {
  if (!user || typeof user !== 'string') throw new Error('completeText: user required');

  const preferred = provider || preferredBrain(req);
  const order = [preferred, 'gemini', 'openai', 'anthropic', 'xai']
    .filter((p, i, a) => a.indexOf(p) === i);

  const errors = [];
  for (const p of order) {
    const { key, source } = keyForProvider(req, p);
    if (!key) continue;
    // Free default: skip user-required providers when brain is gemini and we
    // only have env gemini — already handled by keyForProvider.
    const modelId = model || preferredModel(req, p);
    try {
      return await callProvider(p, key, system, user, maxTokens, modelId);
    } catch (e) {
      errors.push(`${p}/${source}: ${e.message || e}`);
      // Prefer next provider rather than failing the whole request.
    }
  }
  throw new Error(
    errors.length
      ? `All LLM providers failed: ${errors.join(' | ')}`
      : 'No LLM key. Use Free (Gemini) on the server, or add a key under Settings → Your AI.',
  );
}

async function callProvider(provider, key, system, user, maxTokens, model) {
  switch (provider) {
    case 'gemini':
      return geminiComplete(key, system, user, maxTokens, model);
    case 'anthropic':
      return anthropicComplete(key, system, user, maxTokens, model);
    case 'openai':
      return openAiCompatibleComplete('https://api.openai.com/v1', key, system, user, maxTokens, model);
    case 'xai':
      return openAiCompatibleComplete('https://api.x.ai/v1', key, system, user, maxTokens, model);
    default:
      throw new Error(`Unknown provider ${provider}`);
  }
}

async function geminiComplete(key, system, user, maxTokens, model) {
  const m = model || DEFAULT_MODELS.gemini;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`;
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

async function anthropicComplete(key, system, user, maxTokens, model) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODELS.anthropic,
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

async function openAiCompatibleComplete(base, key, system, user, maxTokens, model) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const r = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODELS.openai,
      max_tokens: maxTokens,
      messages,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || JSON.stringify(data).slice(0, 200);
    throw new Error(`OpenAI-compat ${r.status}: ${msg}`);
  }
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * DuckDuckGo HTML search — no API key.
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
