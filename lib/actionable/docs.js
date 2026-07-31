// lib/actionable/docs.js
// ---------------------------------------------------------------------------
// Google DOCS output — the human-readable half of the storage split.
//
// TWO WRITE PATHS, same rendered body:
//   A. OAuth (default)      — Docs REST API. Real headings, real bullets, and
//                             the file lands in an "Actionable" Drive folder.
//   B. Apps Script webhook  — Advanced settings. Posts { title, content } to a
//      (fallback)            user-deployed /exec URL, the contract Troy already
//                             published as PushToDocs.gs:17-21. Plain text only,
//                             because that is all `body.setText(content)` can do.
//
// Path B exists so people already running his blueprint keep working, and so
// anyone who cannot or will not create a Google Cloud project still has an out.
// ---------------------------------------------------------------------------

import { getAccessToken } from './google-auth.js';

const DOCS_CREATE = 'https://docs.googleapis.com/v1/documents';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

// Order the reader wants: what must I DO, what did I DECIDE, then everything else.
const KIND_ORDER = ['task', 'blocker', 'purchase', 'question', 'decision', 'idea', 'note'];
const KIND_HEADING = {
  task: 'Tasks',
  blocker: 'Blockers',
  purchase: 'To buy',
  question: 'Questions',
  decision: 'Decisions',
  idea: 'Ideas',
  note: 'Notes',
};

// ---------------------------------------------------------------------------
// DocBuilder — accumulates plain text while recording the ranges to style.
//
// Google Docs indexes are UTF-16 code units, which is exactly what
// String.prototype.length counts, so offsets computed here transfer directly.
// All text is inserted at index 1 as ONE request; because batchUpdate applies
// requests in order, every later style request addresses the post-insert
// document, and offset o maps to doc index 1+o.
// ---------------------------------------------------------------------------
class DocBuilder {
  constructor() {
    this.text = '';
    this.styles = [];   // paragraph styling
    this.bullets = [];  // bullet ranges
    this.marks = [];    // character styling
  }

  _append(s) {
    const start = this.text.length;
    this.text += s;
    return { start, end: this.text.length };
  }

  // A paragraph range must include its trailing newline for the paragraph style
  // to attach to that paragraph rather than bleeding into the next.
  heading(text, level = 2) {
    const r = this._append(`${text}\n`);
    this.styles.push({ ...r, namedStyleType: `HEADING_${level}` });
    return r;
  }

  para(text, { italic = false, bold = false } = {}) {
    const r = this._append(`${text}\n`);
    this.styles.push({ ...r, namedStyleType: 'NORMAL_TEXT' });
    if (italic || bold) this.marks.push({ ...r, italic, bold });
    return r;
  }

  // One call per contiguous run of bullets: createParagraphBullets applied to a
  // range spanning several paragraphs bullets all of them, and issuing it
  // per-line produces a separate list each time.
  bulletList(lines) {
    if (!lines.length) return;
    const start = this.text.length;
    for (const line of lines) {
      const r = this._append(`${line.text}\n`);
      this.styles.push({ ...r, namedStyleType: 'NORMAL_TEXT' });
      if (line.boldTo) {
        this.marks.push({ start: r.start, end: r.start + line.boldTo, bold: true });
      }
    }
    this.bullets.push({ start, end: this.text.length });
  }

  blank() { this._append('\n'); }

  toRequests() {
    if (!this.text) return [];
    const off = 1; // body content begins at index 1
    const reqs = [{ insertText: { location: { index: off }, text: this.text } }];

    for (const s of this.styles) {
      reqs.push({
        updateParagraphStyle: {
          range: { startIndex: off + s.start, endIndex: off + s.end },
          paragraphStyle: { namedStyleType: s.namedStyleType },
          fields: 'namedStyleType',
        },
      });
    }
    for (const b of this.bullets) {
      reqs.push({
        createParagraphBullets: {
          range: { startIndex: off + b.start, endIndex: off + b.end },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      });
    }
    for (const m of this.marks) {
      const fields = [];
      const textStyle = {};
      if (m.bold) { textStyle.bold = true; fields.push('bold'); }
      if (m.italic) { textStyle.italic = true; fields.push('italic'); }
      if (!fields.length) continue;
      reqs.push({
        updateTextStyle: {
          range: { startIndex: off + m.start, endIndex: off + m.end },
          textStyle,
          fields: fields.join(','),
        },
      });
    }
    return reqs;
  }
}

// ---------------------------------------------------------------------------
// renderDoc — entry → { title, builder, plainText }
// plainText is what the Apps Script path sends, so both paths say the same thing.
// ---------------------------------------------------------------------------
export function renderDoc(entry, { transcript = '', capturedAt = new Date(), timezone = 'America/Denver', projects = [] } = {}) {
  const labelFor = (slug) =>
    projects.find(p => p.slug === slug)?.label
    || String(slug || '').split('-').map(w => w ? w[0].toUpperCase() + w.slice(1) : '').join(' ')
    || 'Unsorted';

  const when = formatWhen(capturedAt, timezone);
  const title = `${entry.title} — ${when.dateShort}`;

  const b = new DocBuilder();
  b.heading(entry.title, 1);
  b.para(`${when.full}${entry.people.length ? ` · with ${entry.people.join(', ')}` : ''}`, { italic: true });
  if (entry.summary) b.para(entry.summary);
  b.blank();

  // Items, grouped by kind. A dump that produced no items still yields a
  // readable doc — summary, photo, transcript — rather than an empty page.
  const byKind = new Map();
  for (const it of entry.items) {
    if (!byKind.has(it.kind)) byKind.set(it.kind, []);
    byKind.get(it.kind).push(it);
  }

  for (const kind of KIND_ORDER) {
    const items = byKind.get(kind);
    if (!items || !items.length) continue;

    b.heading(KIND_HEADING[kind] || kind, 2);
    b.bulletList(items.map(it => {
      // Bold just the item text; the metadata that follows stays plain so the
      // eye lands on the thing to do, not the tags.
      const meta = [];
      meta.push(labelFor(it.project));
      if (it.priority === 'high') meta.push('HIGH');
      if (it.due?.raw || it.due?.iso) meta.push(`due ${it.due.raw || formatWhen(new Date(it.due.iso), timezone).dateShort}`);
      if (it.tags.length) meta.push(it.tags.map(t => `#${t}`).join(' '));

      const head = it.text;
      const tail = meta.length ? `  [${meta.join(' · ')}]` : '';
      const detail = it.detail ? `\n${it.detail}` : '';
      return { text: `${head}${tail}${detail}`, boldTo: head.length };
    }));
    b.blank();
  }

  if (entry.numbers.length) {
    b.heading('Numbers', 2);
    b.bulletList(entry.numbers.map(n => ({
      text: `${n.label}: ${n.value}${n.unit ? ` ${n.unit}` : ''}${n.context ? ` (${n.context})` : ''}`,
      boldTo: n.label.length + 1,
    })));
    b.blank();
  }

  if (entry.open_questions.length) {
    b.heading('Open questions', 2);
    b.bulletList(entry.open_questions.map(q => ({ text: q })));
    b.blank();
  }

  if (entry.image_description || entry.image_text) {
    b.heading('Photo', 2);
    if (entry.image_description) b.para(entry.image_description, { italic: true });
    if (entry.image_text) {
      b.para('Text read from the photo:');
      b.para(entry.image_text);
    }
    b.blank();
  }

  // Repairs and unclear spans are printed, not hidden. If the model guessed
  // wrong, he sees the guess next to what was actually heard and can correct it.
  if (entry.transcription_repairs.length) {
    b.heading('Heard as / read as', 2);
    b.bulletList(entry.transcription_repairs.map(r => ({
      text: `"${r.heard}" → "${r.meant}"${r.why ? ` — ${r.why}` : ''}`,
    })));
    b.blank();
  }

  if (entry.unclear.length) {
    b.heading('Could not make out', 2);
    b.bulletList(entry.unclear.map(u => ({ text: u })));
    b.blank();
  }

  if (transcript) {
    b.heading('Full transcript', 2);
    b.para(transcript);
  }

  return { title, builder: b, plainText: renderPlainText(entry, { transcript, when, labelFor }) };
}

function renderPlainText(entry, { transcript, when, labelFor }) {
  const L = [];
  L.push(entry.title);
  L.push(when.full);
  if (entry.people.length) L.push(`With: ${entry.people.join(', ')}`);
  L.push('');
  if (entry.summary) { L.push(entry.summary); L.push(''); }

  const byKind = new Map();
  for (const it of entry.items) {
    if (!byKind.has(it.kind)) byKind.set(it.kind, []);
    byKind.get(it.kind).push(it);
  }
  for (const kind of KIND_ORDER) {
    const items = byKind.get(kind);
    if (!items?.length) continue;
    L.push((KIND_HEADING[kind] || kind).toUpperCase());
    for (const it of items) {
      const meta = [labelFor(it.project)];
      if (it.priority === 'high') meta.push('HIGH');
      if (it.due?.raw) meta.push(`due ${it.due.raw}`);
      if (it.tags.length) meta.push(it.tags.map(t => `#${t}`).join(' '));
      L.push(`  - ${it.text}  [${meta.join(' · ')}]`);
      if (it.detail) L.push(`      ${it.detail}`);
    }
    L.push('');
  }
  if (entry.numbers.length) {
    L.push('NUMBERS');
    for (const n of entry.numbers) L.push(`  - ${n.label}: ${n.value}${n.unit ? ` ${n.unit}` : ''}${n.context ? ` (${n.context})` : ''}`);
    L.push('');
  }
  if (entry.open_questions.length) {
    L.push('OPEN QUESTIONS');
    for (const q of entry.open_questions) L.push(`  - ${q}`);
    L.push('');
  }
  if (entry.image_description || entry.image_text) {
    L.push('PHOTO');
    if (entry.image_description) L.push(`  ${entry.image_description}`);
    if (entry.image_text) { L.push('  Text read from the photo:'); L.push(`  ${entry.image_text}`); }
    L.push('');
  }
  if (entry.transcription_repairs.length) {
    L.push('HEARD AS / READ AS');
    for (const r of entry.transcription_repairs) L.push(`  - "${r.heard}" -> "${r.meant}"${r.why ? ` — ${r.why}` : ''}`);
    L.push('');
  }
  if (entry.unclear.length) {
    L.push('COULD NOT MAKE OUT');
    for (const u of entry.unclear) L.push(`  - ${u}`);
    L.push('');
  }
  if (transcript) { L.push('FULL TRANSCRIPT'); L.push(transcript); }
  return L.join('\n');
}

function formatWhen(date, timezone) {
  const d = date instanceof Date ? date : new Date(date);
  const opt = { timeZone: timezone };
  try {
    return {
      full: new Intl.DateTimeFormat('en-US', {
        ...opt, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      }).format(d),
      dateShort: new Intl.DateTimeFormat('en-US', { ...opt, month: 'short', day: 'numeric', year: 'numeric' }).format(d),
    };
  } catch {
    // An invalid IANA zone from settings must not take down the write path.
    return { full: d.toISOString(), dateShort: d.toISOString().slice(0, 10) };
  }
}

// ---------------------------------------------------------------------------
// Path A — OAuth Docs API
// ---------------------------------------------------------------------------

async function gfetch(url, token, init = {}) {
  const resp = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Google API ${resp.status} ${url.split('?')[0]}: ${json.error?.message || 'unknown error'}`);
  }
  return json;
}

// Find-or-create the "Actionable" folder. drive.file scope only sees files this
// app created, so this cannot collide with an unrelated folder of the same name
// that he made himself.
export async function ensureFolder(token, name = 'Actionable') {
  const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`);
  const found = await gfetch(`${DRIVE_FILES}?q=${q}&fields=files(id,name)&pageSize=1`, token);
  if (found.files?.length) return found.files[0].id;

  const made = await gfetch(DRIVE_FILES, token, {
    method: 'POST',
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
  });
  return made.id;
}

export async function writeGoogleDoc(userId, entry, opts = {}) {
  const token = await getAccessToken(userId);
  if (!token) return { ok: false, reason: 'not_connected' };

  const { title, builder } = renderDoc(entry, opts);

  const doc = await gfetch(DOCS_CREATE, token, {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  const documentId = doc.documentId;

  const requests = builder.toRequests();
  if (requests.length) {
    await gfetch(`${DOCS_CREATE}/${documentId}:batchUpdate`, token, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  }

  // Filing the doc is a nicety. A folder failure must not lose a written
  // document — it is already safe in My Drive at this point.
  let folderId = opts.folderId || null;
  try {
    if (!folderId) folderId = await ensureFolder(token, opts.folderName || 'Actionable');
    await gfetch(
      `${DRIVE_FILES}/${documentId}?addParents=${folderId}&removeParents=root&fields=id,parents`,
      token, { method: 'PATCH', body: JSON.stringify({}) }
    );
  } catch (e) {
    console.error('[actionable] could not file doc into folder (doc is still created):', e?.message || e);
  }

  return {
    ok: true,
    documentId,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
    folderId,
  };
}

// ---------------------------------------------------------------------------
// Path B — Apps Script webhook (Advanced). Contract: PushToDocs.gs:17-26.
// ---------------------------------------------------------------------------
export async function writeDocViaWebhook(webhookUrl, entry, opts = {}) {
  const { title, plainText } = renderDoc(entry, opts);
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content: plainText }),
  });
  if (!resp.ok) throw new Error(`Docs webhook error ${resp.status}: ${(await resp.text()).slice(0, 200)}`);

  // Apps Script web apps always answer HTTP 200 (PushToDocs.gs:22-26), so the
  // JSON body is the only real status signal — an `error` key means it failed.
  const json = await resp.json().catch(() => ({}));
  if (json.error) throw new Error(`Docs webhook: ${json.error}`);
  return { ok: true, url: json.url || null, documentId: null };
}

// ---------------------------------------------------------------------------
// Sheets — OPTIONAL, and only for number-heavy entries.
//
// Troy's ruling: Docs unless there are a lot of numbers, in which case a
// spreadsheet may make sense AS AN OPTION. So this never runs on its own
// judgement alone: it requires a configured sheet AND the entry clearing the
// user's own numeric_threshold.
// ---------------------------------------------------------------------------
export function shouldAlsoLogToSheet(entry, threshold = 3) {
  return Array.isArray(entry.numbers) && entry.numbers.length >= Math.max(1, threshold);
}

export async function appendToSheet(userId, entry, { sheetId, tab = 'Actionable', capturedAt = new Date() }) {
  const token = await getAccessToken(userId);
  if (!token) return { ok: false, reason: 'not_connected' };

  // One row per NUMBER, not per entry — a spreadsheet is only worth having if
  // the numbers land in their own cells where they can be summed and charted.
  const rows = entry.numbers.map(n => ([
    new Date(capturedAt).toISOString(),
    entry.title,
    n.label,
    n.value,
    n.unit || '',
    n.context || '',
    entry.items.map(i => i.project).filter((v, i, a) => a.indexOf(v) === i).join(', '),
  ]));
  if (!rows.length) return { ok: false, reason: 'no_numbers' };

  const range = encodeURIComponent(`${tab}!A1`);
  await gfetch(
    `${SHEETS_API}/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    token,
    { method: 'POST', body: JSON.stringify({ values: rows }) }
  );
  return { ok: true, rows: rows.length };
}

// Legacy Apps Script Sheets webhook — the exact { row } contract from
// api/diary.js:160-164 and BLUEPRINT_VOICE.md:74, so an existing blueprint
// deployment keeps working with no change on the user's side.
export async function appendToSheetWebhook(webhookUrl, entry, { capturedAt = new Date(), transcript = '' }) {
  const d = new Date(capturedAt);
  const row = [
    d.toISOString().slice(0, 10),
    d.toISOString().slice(11, 16),
    entry.items.map(i => i.project).filter((v, i, a) => a.indexOf(v) === i).join(', '),
    entry.items.map(i => i.kind).filter((v, i, a) => a.indexOf(v) === i).join(', '),
    entry.items.some(i => i.priority === 'high') ? 'High' : 'Medium',
    entry.summary,
    entry.items.map(i => i.text).join(' | '),
    entry.items.flatMap(i => i.tags).join(' '),
    transcript,
  ];
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ row }),
  });
  if (!resp.ok) throw new Error(`Sheets webhook error ${resp.status}`);
  return { ok: true };
}
