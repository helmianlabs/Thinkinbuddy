// lib/actionable/providers.js
// ---------------------------------------------------------------------------
// ONE extraction call, N interchangeable vendors, automatic fallback.
//
// WHY THIS EXISTS
//   The Anthropic key on this account returns HTTP 400 "credit balance too low"
//   on every call, which takes the whole app down — there was no second path.
//   Structuring a brain dump is not a task that needs a frontier model; it needs
//   a model that reliably emits a JSON object matching a fixed schema. Several
//   vendors do that for well under a cent per capture.
//
// THE CONTRACT
//   Every provider exports the same call(): take a system prompt, some text, an
//   optional image, and a JSON schema; return { text } where text is a JSON
//   object string. Everything vendor-specific — auth header, endpoint shape,
//   how an image is attached, how a schema is enforced — is hidden in here.
//   extract.js does not know which vendor answered.
//
// CHOOSING / SWITCHING — one value:
//   ACTIONABLE_LLM_PROVIDER=openai        primary vendor
//   ACTIONABLE_LLM_FALLBACK=gemini,anthropic   tried in order when it fails
//   Both optional. With neither set, every vendor whose key is present is used,
//   in DEFAULT_ORDER. Topping the Anthropic account back up therefore needs no
//   code change at all: it re-enters the chain the moment its key works again.
//   To make it primary again, set ACTIONABLE_LLM_PROVIDER=anthropic.
//
// NO NULLS ON THE WIRE — the one design decision worth knowing.
//   OpenAI strict schemas express "absent" as a `["string","null"]` union;
//   Gemini's schema subset historically wants `nullable: true`. Rather than
//   maintain two dialects of the same idea, the schema (prompt.js) has NO
//   nullable fields: absent is the empty string, and normalizeEntry() in
//   extract.js already turns "" into null on the way to the database. One
//   schema, byte-identical semantics on all three vendors.
// ---------------------------------------------------------------------------

import { rulesProvider } from './rules.js';

export const DEFAULT_ORDER = ['openai', 'gemini', 'anthropic'];

// ---------------------------------------------------------------------------
// Models. Every one is overridable by env so a price change or a deprecation is
// a dashboard edit, not a deploy.
//
// Prices verified 2026-07-29 against the vendors' own pricing pages, per 1M
// tokens in / out:
//   gpt-4.1-mini            $0.40 / $1.60   developers.openai.com/api/docs/pricing
//   gpt-4.1-nano            $0.10 / $0.40   (cheaper, weaker at long prompts)
//   gpt-5-nano              $0.05 / $0.40   (cheapest, but a reasoning model —
//                                            reasoning tokens bill as output and
//                                            add latency on a phone capture)
//   gemini-2.5-flash-lite   $0.10 / $0.40   ai.google.dev/gemini-api/docs/pricing
//   claude-haiku-4-5        (comparison only — the account is out of credit)
//
// DEFAULT = gpt-4.1-mini. A capture is ~2k in / ~1.5k out ⇒ ~$0.0032 each,
// about $2/month at 20 dumps a day. It is NOT the cheapest line on the sheet;
// it is chosen because it is not a reasoning model (predictable latency when
// you are stood in a yard waiting for the entry to land), it takes images for
// the photo-OCR path, and it enforces a strict JSON schema natively. The gap to
// the cheapest option is under $2/month — far less than one lost brain dump.
// ---------------------------------------------------------------------------
export const MODELS = {
  openai: process.env.ACTIONABLE_OPENAI_MODEL || 'gpt-4.1-mini',
  gemini: process.env.ACTIONABLE_GEMINI_MODEL || 'gemini-2.5-flash-lite',
  anthropic: process.env.ACTIONABLE_ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
  rules: 'rules-v1',
};

const KEY_ENV = {
  openai: ['OPENAI_API_KEY'],
  // GEMINI_API_KEY / GOOGLE_GENAI_API_KEY only — deliberately NOT GOOGLE_API_KEY,
  // even though much of the ecosystem accepts that name. This project already
  // has a GOOGLE_API_KEY set in Vercel production for something else entirely,
  // so honouring it here would silently enter a wrong key into the extraction
  // chain and turn every capture into a 401 plus a fallback nobody ordered.
  gemini: ['GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
};

export function apiKeyFor(provider, env = process.env) {
  for (const name of KEY_ENV[provider] || []) {
    const v = env[name];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export function isConfigured(provider, env = process.env) {
  // The rules engine is local code — no key, no network — so it counts as
  // configured. It is NOT in DEFAULT_ORDER: it only enters the chain when
  // explicitly named (ACTIONABLE_LLM_PROVIDER=rules or in the fallback
  // list), so default behavior is unchanged.
  if (provider === 'rules') return true;
  return Boolean(apiKeyFor(provider, env));
}

// ---------------------------------------------------------------------------
// resolveChain — the ordered list of vendors this request will try.
//
// Unconfigured vendors are dropped rather than attempted, so a missing key is
// never reported as a vendor outage.
// ---------------------------------------------------------------------------
export function resolveChain(env = process.env) {
  const parse = (s) => String(s || '')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

  const primary = parse(env.ACTIONABLE_LLM_PROVIDER);
  const fallback = parse(env.ACTIONABLE_LLM_FALLBACK);

  const wanted = (primary.length || fallback.length)
    ? [...primary, ...fallback, ...DEFAULT_ORDER]
    : [...DEFAULT_ORDER];

  const seen = new Set();
  return wanted.filter(p =>
    PROVIDERS[p] && !seen.has(p) && (seen.add(p), true) && isConfigured(p, env));
}

// A deliberately unreachable vendor, for proving the fallback actually falls
// back. Comma-separated list of provider names; unset in normal operation.
function isForcedToFail(provider, env = process.env) {
  return String(env.ACTIONABLE_LLM_FORCE_FAIL || '')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
    .includes(provider);
}

// ---------------------------------------------------------------------------
// callExtraction — try each configured vendor in order; the first JSON wins.
//
// Returns { text, provider, model, stopReason, attempts } where `attempts`
// records every vendor tried and why it failed. That array is what turns
// "extraction failed" into "openai: 429 rate limited → gemini: no key →
// anthropic: credit balance too low", which is the difference between a
// five-minute fix and an evening.
// ---------------------------------------------------------------------------
export async function callExtraction({
  system,
  text,
  imageBase64 = null,
  imageMime = null,
  schema = null,
  maxTokens = 4096,
  env = process.env,
  fetchImpl = fetch,
  context = null,
} = {}) {
  const chain = resolveChain(env);
  if (!chain.length) {
    throw new Error(
      'No LLM provider is configured. Set one of OPENAI_API_KEY, GEMINI_API_KEY ' +
      'or ANTHROPIC_API_KEY.'
    );
  }

  const attempts = [];
  for (const name of chain) {
    const model = MODELS[name];
    try {
      if (isForcedToFail(name, env)) {
        throw new Error(`forced failure via ACTIONABLE_LLM_FORCE_FAIL (${name})`);
      }
      const out = await PROVIDERS[name].call({
        system, text, imageBase64, imageMime, schema, maxTokens,
        apiKey: apiKeyFor(name, env), model, fetchImpl, context,
      });
      if (!out || !String(out.text || '').trim()) {
        throw new Error('provider returned an empty response body');
      }
      attempts.push({ provider: name, model, ok: true });
      return { ...out, provider: name, model, attempts };
    } catch (e) {
      attempts.push({ provider: name, model, ok: false, error: e?.message || String(e) });
    }
  }

  const detail = attempts.map(a => `${a.provider} (${a.model}): ${a.error}`).join(' | ');
  const err = new Error(`Every LLM provider failed — ${detail}`);
  err.attempts = attempts;
  throw err;
}

// ---------------------------------------------------------------------------
// OpenAI — Chat Completions with strict Structured Outputs.
//
// `strict: true` means the response is CONSTRAINED to the schema during
// decoding rather than merely requested, so "the model returned prose today"
// stops being a failure mode. Requires every key listed in `required` and
// `additionalProperties: false` on every object — which is why the schema in
// prompt.js is written that way.
// Docs: https://developers.openai.com/api/docs/guides/structured-outputs
// ---------------------------------------------------------------------------
const openai = {
  name: 'openai',
  async call({ system, text, imageBase64, imageMime, schema, maxTokens, apiKey, model, fetchImpl }) {
    const content = [{ type: 'text', text }];
    if (imageBase64) {
      content.unshift({
        type: 'image_url',
        image_url: { url: `data:${cleanMime(imageMime)};base64,${imageBase64}` },
      });
    }

    const body = {
      model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
    };
    if (schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'actionable_entry', strict: true, schema },
      };
    } else {
      body.response_format = { type: 'json_object' };
    }

    const resp = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${trim(await resp.text())}`);

    const json = await resp.json();
    const choice = json.choices?.[0];
    // A safety refusal comes back in its own field; it is NOT valid JSON and
    // must not be handed to the parser as if it were a malformed entry.
    if (choice?.message?.refusal) throw new Error(`model refused: ${choice.message.refusal}`);
    return { text: choice?.message?.content || '', stopReason: mapStop(choice?.finish_reason) };
  },
};

// ---------------------------------------------------------------------------
// Gemini — generateContent with responseMimeType + responseSchema.
//
// The schema subset is OpenAPI-flavoured: uppercase type names, no
// `additionalProperties`, and field order comes from `propertyOrdering` rather
// than object key order. toGeminiSchema() does that translation so the app
// keeps exactly one schema definition.
// Docs: https://ai.google.dev/gemini-api/docs/structured-output
// ---------------------------------------------------------------------------
const gemini = {
  name: 'gemini',
  async call({ system, text, imageBase64, imageMime, schema, maxTokens, apiKey, model, fetchImpl }) {
    const parts = [];
    if (imageBase64) {
      parts.push({ inline_data: { mime_type: cleanMime(imageMime), data: imageBase64 } });
    }
    parts.push({ text });

    const generationConfig = {
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
    };
    if (schema) generationConfig.responseSchema = toGeminiSchema(schema);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const resp = await fetchImpl(url, {
      method: 'POST',
      // Header form, not ?key= — a key in a query string lands in access logs
      // and in any proxy in between.
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${trim(await resp.text())}`);

    const json = await resp.json();
    const cand = json.candidates?.[0];
    if (!cand && json.promptFeedback?.blockReason) {
      throw new Error(`blocked: ${json.promptFeedback.blockReason}`);
    }
    const out = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join('');
    return { text: out, stopReason: mapStop(cand?.finishReason) };
  },
};

// ---------------------------------------------------------------------------
// Anthropic — Messages API. Kept as the third path, unchanged in shape from the
// call this file replaced, so restoring it is only ever a config change.
//
// It has no `strict` mode here: the prompt asks for JSON and parseJsonLoose()
// plus normalizeEntry() catch the difference. That asymmetry is the reason it
// sits last in DEFAULT_ORDER rather than first.
// ---------------------------------------------------------------------------
const anthropic = {
  name: 'anthropic',
  async call({ system, text, imageBase64, imageMime, maxTokens, apiKey, model, fetchImpl }) {
    const content = [];
    if (imageBase64) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: cleanMime(imageMime), data: imageBase64 },
      });
    }
    content.push({ type: 'text', text });

    const resp = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${trim(await resp.text())}`);

    const json = await resp.json();
    return {
      text: json.content?.find(b => b.type === 'text')?.text || '',
      stopReason: mapStop(json.stop_reason),
    };
  },
};

export const PROVIDERS = { openai, gemini, anthropic, rules: rulesProvider };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Every vendor rejects a media type carrying a charset parameter.
function cleanMime(mime) {
  return String(mime || 'image/jpeg').split(';')[0].trim().toLowerCase();
}

function trim(s) {
  return String(s || '').slice(0, 300);
}

// Each vendor spells "I ran out of room" differently. The caller only needs to
// know whether the answer was cut off, so normalize to one word.
function mapStop(reason) {
  const r = String(reason || '').toLowerCase();
  if (r === 'length' || r === 'max_tokens' || r === 'max_output_tokens') return 'max_tokens';
  return r || 'stop';
}

// ---------------------------------------------------------------------------
// toGeminiSchema — OpenAI-strict JSON Schema → Gemini responseSchema.
//   - type names uppercased      ("string" → "STRING")
//   - additionalProperties dropped (not part of Gemini's subset)
//   - propertyOrdering added      (Gemini emits keys in this order; without it
//                                  field order is unspecified, which makes two
//                                  identical calls diff against each other)
// ---------------------------------------------------------------------------
export function toGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (!node || typeof node !== 'object') return node;

  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'additionalProperties') continue;
    if (k === 'type') { out.type = String(v).toUpperCase(); continue; }
    if (k === 'properties') {
      out.properties = Object.fromEntries(
        Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
      out.propertyOrdering = Object.keys(v);
      continue;
    }
    if (k === 'items') { out.items = toGeminiSchema(v); continue; }
    out[k] = v;
  }
  return out;
}
