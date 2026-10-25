// lib/actionable/extract.js
// ---------------------------------------------------------------------------
// Audio → transcript → structured entry, plus photo OCR.
//
// Lifted in shape from api/diary.js (which keeps working, untouched — Troy sells
// a blueprint of it), with four substantive changes:
//   1. The construction-site prompt is gone; see lib/actionable/prompt.js.
//   2. max_tokens 512 → 4096. 512 truncates any real multi-item dump mid-array,
//      producing invalid JSON that the old code silently swallowed into a
//      one-field fallback object (api/diary.js:143-145).
//   3. Photos go to the SAME extraction call as the transcript, so OCR text and
//      the spoken words are interpreted together rather than in isolation.
//   4. The model's JSON is VALIDATED and normalized before it can touch the
//      database. An LLM that returns a string where an array belongs must not be
//      able to corrupt a row.
//   5. The vendor is no longer hardcoded. callExtraction() (providers.js) tries
//      OpenAI → Gemini → Anthropic, or whatever ACTIONABLE_LLM_PROVIDER /
//      ACTIONABLE_LLM_FALLBACK say, and moves on when one fails. This file was
//      previously bolted to Anthropic alone, so "credit balance too low" meant
//      no captures at all.
// ---------------------------------------------------------------------------

import {
  buildSystemPrompt,
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_MAX_TOKENS,
  ITEM_KINDS,
  PRIORITIES,
} from './prompt.js';
import { callExtraction } from './providers.js';

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

// All three vendors accept these image media types. Anything else is stored as
// an attachment but never sent to the model.
const VISION_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function isVisionMime(mime) {
  return VISION_MIME.has(String(mime || '').toLowerCase().split(';')[0].trim());
}

// ---------------------------------------------------------------------------
// transcribeAudio — OpenAI Whisper.
//
// Byte-for-byte the manual-multipart approach from api/diary.js:56-95. It is
// verbose next to FormData, but it is the version proven to work on Vercel's
// Node runtime in this project, and this is not the place to find out that a
// tidier version streams differently.
// ---------------------------------------------------------------------------
export async function transcribeAudio(base64, mimeType, openaiKey) {
  const buf = Buffer.from(base64, 'base64');
  const m = String(mimeType || 'audio/webm');
  const ext = m.includes('mp4') || m.includes('m4a') ? 'm4a'
    : m.includes('ogg') ? 'ogg'
    : m.includes('wav') ? 'wav'
    : 'webm';

  const boundary = '----ActionableBoundary' + Date.now();
  const nl = '\r\n';
  let head = '';
  head += `--${boundary}${nl}`;
  head += `Content-Disposition: form-data; name="model"${nl}${nl}`;
  head += `whisper-1${nl}`;
  head += `--${boundary}${nl}`;
  head += `Content-Disposition: form-data; name="language"${nl}${nl}`;
  head += `en${nl}`;
  head += `--${boundary}${nl}`;
  head += `Content-Disposition: form-data; name="file"; filename="audio.${ext}"${nl}`;
  head += `Content-Type: ${m}${nl}${nl}`;

  const full = Buffer.concat([
    Buffer.from(head, 'utf8'),
    buf,
    Buffer.from(`${nl}--${boundary}--${nl}`, 'utf8'),
  ]);

  const resp = await fetch(WHISPER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: full,
  });

  if (!resp.ok) {
    throw new Error(`Whisper error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const json = await resp.json();
  return json.text || '';
}

// ---------------------------------------------------------------------------
// extractEntry — the one model call that does structuring AND image OCR.
//
// `env` and `fetchImpl` are injectable so the provider chain and its fallback
// can be exercised in a test without touching process.env or the network.
// ---------------------------------------------------------------------------
export async function extractEntry({
  transcript,
  imageBase64 = null,
  imageMime = null,
  projects,
  tags,
  people,
  nowIso,
  timezone,
  env = process.env,
  fetchImpl = fetch,
}) {
  const hasImage = Boolean(imageBase64 && isVisionMime(imageMime));

  const text = transcript && transcript.trim()
    ? `Brain dump (spoken):\n"""\n${transcript}\n"""`
    // Photo-only capture is legitimate: snap a whiteboard, say nothing.
    : 'No audio was recorded — this capture is the attached photo only. Build the entry from what the photo shows.';

  const { text: raw, stopReason, provider, model, attempts } = await callExtraction({
    system: buildSystemPrompt({ projects, tags, people, nowIso, timezone, hasImage }),
    text,
    imageBase64: hasImage ? imageBase64 : null,
    imageMime: hasImage ? imageMime : null,
    schema: EXTRACTION_JSON_SCHEMA,
    maxTokens: EXTRACTION_MAX_TOKENS,
    env,
    fetchImpl,
    // Ignored by the vendor providers; the local `rules` provider reads
    // its context from here instead of parsing it back out of the prompt.
    context: { projects, tags, people, nowIso, timezone },
  });

  // A truncated response is the failure mode the old 512-token budget hit
  // constantly. Surface it loudly instead of returning half an entry.
  if (stopReason === 'max_tokens') {
    throw new Error(
      'Extraction hit the token ceiling — the dump produced more structure than ' +
      `${EXTRACTION_MAX_TOKENS} tokens allows. The transcript is safe; re-run or split the recording.`
    );
  }

  const entry = normalizeEntry(parseJsonLoose(raw), { hasImage, rawModelText: raw });
  // Which vendor actually answered, and who was tried first. Without this a
  // silent fallback to a weaker model looks like the model got worse overnight.
  entry.extracted_by = { provider, model };
  if (attempts.some(a => !a.ok)) {
    entry.provider_fallbacks = attempts.filter(a => !a.ok)
      .map(a => `${a.provider} (${a.model}): ${a.error}`);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// parseJsonLoose — tolerate the two things models actually do wrong: wrap JSON
// in a markdown fence, or emit a sentence before the object.
// ---------------------------------------------------------------------------
export function parseJsonLoose(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Model returned an empty response');

  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch {
    // Fall back to the outermost {...} span.
    const first = unfenced.indexOf('{');
    const last = unfenced.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(unfenced.slice(first, last + 1));
      } catch { /* fall through to the throw below */ }
    }
    throw new Error(`Model did not return valid JSON. First 200 chars: ${unfenced.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// normalizeEntry — the gate between the model and the database.
//
// Every field is coerced to its declared type with a safe default. This is not
// defensive padding: the old code's `catch { return {summary: raw, ...} }`
// (api/diary.js:143-145) meant a malformed response was written to the Sheet as
// a row whose "summary" was the raw model text. Silent corruption. Here a bad
// shape degrades field-by-field and the entry still lands with its transcript
// intact.
// ---------------------------------------------------------------------------
export function normalizeEntry(obj, { hasImage = false, rawModelText = '' } = {}) {
  const o = (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};

  const str = (v, fallback = '') =>
    (typeof v === 'string' && v.trim()) ? v.trim() : fallback;

  const strArray = (v) => Array.isArray(v)
    ? v.map(x => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
    : [];

  const oneOf = (v, allowed, fallback) => {
    const s = String(v || '').toLowerCase().trim();
    return allowed.includes(s) ? s : fallback;
  };

  const slug = (v, fallback) => {
    const s = String(v || '').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s || fallback;
  };

  const isoOrNull = (v) => {
    if (typeof v !== 'string' || !v.trim()) return null;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  };

  const items = (Array.isArray(o.items) ? o.items : [])
    .map(rawItem => {
      const it = (rawItem && typeof rawItem === 'object') ? rawItem : {};
      const text = str(it.text);
      if (!text) return null; // an item with no text is not an item

      // due: accept {raw, iso}, or a bare ISO string, or null.
      let due = null;
      if (it.due && typeof it.due === 'object') {
        const iso = isoOrNull(it.due.iso);
        const rawDue = str(it.due.raw);
        if (iso || rawDue) due = { raw: rawDue || null, iso };
      } else if (typeof it.due === 'string' && it.due.trim()) {
        const iso = isoOrNull(it.due);
        due = { raw: it.due.trim(), iso };
      }

      // phone_action: only survives if it carries a usable time.
      const pa = (it.phone_action && typeof it.phone_action === 'object') ? it.phone_action : {};
      const paKind = oneOf(pa.kind, ['reminder', 'calendar_event', 'none'], 'none');
      const paWhen = isoOrNull(pa.when_iso);
      const phone_action = (paKind !== 'none' && paWhen)
        ? {
            kind: paKind,
            title: str(pa.title, text).slice(0, 200),
            when_iso: paWhen,
            duration_min: Number.isFinite(Number(pa.duration_min))
              ? Math.max(5, Math.min(1440, Math.trunc(Number(pa.duration_min))))
              : (paKind === 'calendar_event' ? 30 : null),
          }
        : { kind: 'none', title: null, when_iso: null, duration_min: null };

      return {
        kind: oneOf(it.kind, ITEM_KINDS, 'note'),
        text,
        detail: str(it.detail),
        project: slug(it.project, 'personal'),
        project_is_new: it.project_is_new === true,
        tags: strArray(it.tags).map(t => slug(t, '')).filter(Boolean).slice(0, 12),
        priority: oneOf(it.priority, PRIORITIES, 'medium'),
        due,
        phone_action,
      };
    })
    .filter(Boolean);

  const numbers = (Array.isArray(o.numbers) ? o.numbers : [])
    .map(rawNum => {
      const n = (rawNum && typeof rawNum === 'object') ? rawNum : {};
      const value = Number(n.value);
      if (!Number.isFinite(value)) return null;
      return {
        label: str(n.label, 'value'),
        value,
        unit: str(n.unit),
        context: str(n.context),
      };
    })
    .filter(Boolean);

  const repairs = (Array.isArray(o.transcription_repairs) ? o.transcription_repairs : [])
    .map(rawRep => {
      const r = (rawRep && typeof rawRep === 'object') ? rawRep : {};
      const heard = str(r.heard);
      const meant = str(r.meant);
      if (!heard || !meant) return null;
      return { heard, meant, why: str(r.why) };
    })
    .filter(Boolean);

  const entry = {
    // The model's own enumeration of the dump. Kept because it is the only way
    // to see WHAT was noticed but not turned into an item — a topic with no
    // matching item is the silent drop this system cannot tolerate.
    topics: strArray(o.topics).slice(0, 40),
    title: str(o.title, 'Untitled entry').slice(0, 200),
    summary: str(o.summary),
    items,
    people: strArray(o.people).slice(0, 40),
    numbers,
    open_questions: strArray(o.open_questions),
    transcription_repairs: repairs,
    unclear: strArray(o.unclear),
    image_has_text: false,
    image_text: null,
    image_description: null,
  };

  if (hasImage) {
    entry.image_text = str(o.image_text) || null;
    // Trust the presence of extracted text over the model's own boolean — a
    // model that returns text while flagging has_text:false would otherwise
    // drop that text out of the search index.
    entry.image_has_text = Boolean(entry.image_text) || o.image_has_text === true;
    entry.image_description = str(o.image_description) || null;
  }

  // If the model returned nothing usable at all, keep the raw text so nothing
  // the user said is lost — but say so plainly rather than passing it off as a
  // summary.
  if (!entry.items.length && !entry.summary) {
    entry.summary = '(Could not structure this dump — the transcript is preserved below.)';
    entry.extraction_failed = true;
    entry.raw_model_text = String(rawModelText || '').slice(0, 4000);
  }

  return entry;
}

// ---------------------------------------------------------------------------
// searchableText — one blob per entry for Postgres full-text + embedding.
// Includes OCR'd photo text, which is the whole point of the "always attach the
// image AND OCR it" ruling: a photographed whiteboard becomes findable prose.
// ---------------------------------------------------------------------------
export function searchableText(entry, transcript) {
  return [
    entry.title,
    entry.summary,
    transcript,
    entry.image_text,
    entry.image_description,
    ...entry.items.map(i => `${i.text} ${i.detail} ${i.tags.join(' ')} ${i.project}`),
    ...entry.people,
    ...entry.open_questions,
    ...entry.numbers.map(n => `${n.label} ${n.value} ${n.unit} ${n.context}`),
  ].filter(Boolean).join('\n');
}
