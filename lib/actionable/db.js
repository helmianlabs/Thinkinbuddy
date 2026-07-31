// lib/actionable/db.js
// ---------------------------------------------------------------------------
// Postgres layer for Actionable: the SEARCH + TAG index.
//
// STORAGE SPLIT (deliberate, see docs/ACTIONABLE_SETUP.md):
//   Google Docs  = the human-readable output he actually reads.
//   Postgres     = the index that makes search and tagging fast.
//   Sheets       = optional, and only for entries that are mostly numbers.
//
// Sheets is a poor database. Searching "what did I say about the DFA pilot" across
// a year of rows means pulling the whole sheet over an Apps Script webhook and
// filtering in JS. Tag filtering means a full scan. Both get slower every week.
// Postgres does it in one indexed query and is ALREADY in this app.
//
// REUSE, NOT A SECOND STORE: getPool/embed/vecLiteral are imported from
// api/memory.js, which documents them at :69-71 as "Shared helpers for other API
// routes ... Keep these exports stable". Same Neon instance, same pool, separate
// tables. Nothing in memory_items is read or written here.
// ---------------------------------------------------------------------------

import { getPool, embed, vecLiteral } from '../../api/memory.js';
import { SEED_PROJECTS } from './prompt.js';

export { getPool };

// ---------------------------------------------------------------------------
// Projects — the user's editable category set. THIS is what makes categories
// data instead of a hardcoded list.
// ---------------------------------------------------------------------------

export async function listProjects(userId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT slug, label, hint, color, sort_order
       FROM actionable_projects
      WHERE user_id = $1 AND archived = false
      ORDER BY sort_order ASC, label ASC`,
    [userId]
  );
  return rows.map(r => ({
    slug: r.slug, label: r.label, hint: r.hint || '', color: r.color || null,
  }));
}

// Called once when an account first appears. Seeds are a STARTING POINT the user
// then owns — this never re-applies over their edits, because it only runs when
// the user has zero project rows.
export async function ensureSeedProjects(userId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM actionable_projects WHERE user_id = $1`,
    [userId]
  );
  if (rows[0].n > 0) return false;

  for (let i = 0; i < SEED_PROJECTS.length; i++) {
    const p = SEED_PROJECTS[i];
    await pool.query(
      `INSERT INTO actionable_projects (user_id, slug, label, hint, sort_order)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, slug) DO NOTHING`,
      [userId, p.slug, p.label, p.hint, i]
    );
  }
  return true;
}

export async function upsertProject(userId, { slug, label, hint = '', color = null, sortOrder = 100 }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO actionable_projects (user_id, slug, label, hint, color, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, slug)
       DO UPDATE SET label = EXCLUDED.label,
                     hint  = EXCLUDED.hint,
                     color = EXCLUDED.color,
                     archived = false
     RETURNING slug, label, hint, color`,
    [userId, slug, label, hint, color, sortOrder]
  );
  return rows[0];
}

export async function archiveProject(userId, slug) {
  const pool = getPool();
  // Archive, never DELETE: items already tagged with this slug keep their tag and
  // stay findable. A delete would orphan history to tidy a settings screen.
  const r = await pool.query(
    `UPDATE actionable_projects SET archived = true WHERE user_id = $1 AND slug = $2`,
    [userId, slug]
  );
  return { archived: r.rowCount };
}

// Tags the user has actually used, most-used first. Fed back into the prompt so
// the model reuses "dfa" instead of inventing "dfa-pilot", "DFA", "dfa_stuff".
export async function listKnownTags(userId, limit = 60) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT tag, count(*)::int AS n
       FROM actionable_items, unnest(tags) AS tag
      WHERE user_id = $1
      GROUP BY tag
      ORDER BY n DESC, tag ASC
      LIMIT $2`,
    [userId, limit]
  );
  return rows.map(r => r.tag);
}

// ---------------------------------------------------------------------------
// People already seen, most-mentioned first.
//
// WHY THIS EXISTS: proof run 2026-07-29 showed the extractor cannot repair a name
// it has never encountered — a colleague's name came through as "Saudi" and was
// filed as a person under that spelling, because nothing in the prompt said who
// this user actually deals with. Names are the highest-value repair (a mangled
// name still reads as a plausible word, so it survives every other check) and
// the one the model is worst at unaided. Feeding the known list back in is the
// same trick as listKnownTags, applied where it matters most.
export async function listKnownPeople(userId, limit = 40) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT person, count(*)::int AS n
       FROM actionable_entries, unnest(people) AS person
      WHERE user_id = $1
      GROUP BY person
      ORDER BY n DESC, person ASC
      LIMIT $2`,
    [userId, limit]
  );
  return rows.map(r => r.person);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(userId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT timezone, sheets_webhook, docs_webhook, sheet_id, numeric_threshold, doc_folder_id
       FROM actionable_settings WHERE user_id = $1`,
    [userId]
  );
  if (!rows.length) {
    return {
      timezone: 'America/Denver',
      sheets_webhook: null,
      docs_webhook: null,
      sheet_id: null,
      numeric_threshold: 3,
      doc_folder_id: null,
    };
  }
  return rows[0];
}

export async function saveSettings(userId, patch) {
  const pool = getPool();
  const cur = await getSettings(userId);
  const next = { ...cur, ...patch };
  const { rows } = await pool.query(
    `INSERT INTO actionable_settings
       (user_id, timezone, sheets_webhook, docs_webhook, sheet_id, numeric_threshold, doc_folder_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id) DO UPDATE SET
       timezone = EXCLUDED.timezone,
       sheets_webhook = EXCLUDED.sheets_webhook,
       docs_webhook = EXCLUDED.docs_webhook,
       sheet_id = EXCLUDED.sheet_id,
       numeric_threshold = EXCLUDED.numeric_threshold,
       doc_folder_id = EXCLUDED.doc_folder_id
     RETURNING timezone, sheets_webhook, docs_webhook, sheet_id, numeric_threshold, doc_folder_id`,
    [userId, next.timezone, next.sheets_webhook, next.docs_webhook,
     next.sheet_id, next.numeric_threshold, next.doc_folder_id]
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// Entries + items
// ---------------------------------------------------------------------------

export async function saveEntry({
  userId,
  entry,
  transcript,
  searchText,
  imageUrl = null,
  imageMime = null,
  capturedAt = null,
  timezone = 'America/Denver',
  source = 'app',
}) {
  const pool = getPool();

  // Embedding is a BONUS ranking signal. Full-text search must work without it,
  // so a missing/failing OPENAI_API_KEY degrades ranking rather than losing the
  // entry. Same fail-soft posture as api/memory.js:115-116.
  let vec = null;
  try {
    vec = await embed(searchText);
  } catch (e) {
    console.error('[actionable] embed failed (entry still saved, full-text only):', e?.message || e);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // $6 is ALWAYS bound, and is simply null when embedding was unavailable.
    // Do NOT switch the placeholder out for a literal NULL: that shortens the
    // parameter list by one and silently shifts every argument after it, so
    // image_url would land in the embedding column. Postgres casts NULL::vector
    // without complaint, so the branch buys nothing and costs correctness.
    const { rows } = await client.query(
      `INSERT INTO actionable_entries
         (user_id, title, summary, transcript, search_text, embedding,
          image_url, image_mime, image_text, image_description,
          people, open_questions, numbers, transcription_repairs, unclear,
          captured_at, timezone, source, raw)
       VALUES ($1,$2,$3,$4,$5,$6::vector,
               $7,$8,$9,$10,
               $11,$12,$13::jsonb,$14::jsonb,$15,
               COALESCE($16::timestamptz, now()),$17,$18,$19::jsonb)
       RETURNING id, captured_at`,
      [
        userId, entry.title, entry.summary, transcript || '', searchText,
        vec ? vecLiteral(vec) : null,
        imageUrl, imageMime, entry.image_text, entry.image_description,
        entry.people, entry.open_questions,
        JSON.stringify(entry.numbers), JSON.stringify(entry.transcription_repairs),
        entry.unclear,
        capturedAt, timezone, source, JSON.stringify(entry),
      ]
    );

    const entryId = rows[0].id;

    for (let i = 0; i < entry.items.length; i++) {
      const it = entry.items[i];
      await client.query(
        `INSERT INTO actionable_items
           (entry_id, user_id, position, kind, text, detail, project, project_is_new,
            tags, priority, due_raw, due_at, phone_action)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
        [
          entryId, userId, i, it.kind, it.text, it.detail, it.project, it.project_is_new,
          it.tags, it.priority,
          it.due?.raw || null, it.due?.iso || null,
          JSON.stringify(it.phone_action),
        ]
      );

      // A project the model invented becomes a real, editable row so it shows up
      // in settings and in the next prompt — instead of existing only as an
      // orphan string on one item.
      if (it.project_is_new) {
        await client.query(
          `INSERT INTO actionable_projects (user_id, slug, label, hint, sort_order)
           VALUES ($1,$2,$3,'',500)
           ON CONFLICT (user_id, slug) DO NOTHING`,
          [userId, it.project, titleCase(it.project)]
        );
      }
    }

    await client.query('COMMIT');
    return { id: entryId, capturedAt: rows[0].captured_at };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function titleCase(slug) {
  return String(slug).split('-').filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// Recorded after the fact so a Docs/Sheets failure can never lose the entry —
// the row is committed first, the external write is stamped on afterwards.
export async function attachOutputs(entryId, { docUrl = null, docId = null, sheetOk = null }) {
  const pool = getPool();
  await pool.query(
    `UPDATE actionable_entries
        SET doc_url = COALESCE($2, doc_url),
            doc_id = COALESCE($3, doc_id),
            sheet_logged = COALESCE($4, sheet_logged)
      WHERE id = $1`,
    [entryId, docUrl, docId, sheetOk]
  );
}

// ---------------------------------------------------------------------------
// SEARCH — "find something I dictated last week".
//
// HYBRID, and the order matters:
//   1. Postgres full-text over search_text (a GENERATED tsvector column, so it
//      can never drift out of sync with the text it indexes).
//   2. Vector similarity, when an embedding is available, for the case where he
//      remembers the GIST but not the WORDS — the common case for a brain dump
//      three weeks old.
// Scores are combined rather than one falling back to the other, so an exact
// phrase match still beats a vaguely-related entry.
// ---------------------------------------------------------------------------
export async function searchEntries(userId, {
  q = '',
  project = null,
  tag = null,
  kind = null,
  since = null,
  until = null,
  limit = 25,
  offset = 0,
} = {}) {
  const pool = getPool();
  const query = String(q || '').trim();

  let vec = null;
  if (query) {
    try { vec = await embed(query); }
    catch (e) { console.error('[actionable] search embed failed (full-text only):', e?.message || e); }
  }

  const params = [userId];
  const where = ['e.user_id = $1'];

  if (query) {
    params.push(query);
    where.push(`(e.search_tsv @@ websearch_to_tsquery('english', $${params.length})
                 OR e.search_text ILIKE '%' || $${params.length} || '%')`);
  }
  if (project) { params.push(project); where.push(`EXISTS (SELECT 1 FROM actionable_items i WHERE i.entry_id = e.id AND i.project = $${params.length})`); }
  if (tag)     { params.push(tag);     where.push(`EXISTS (SELECT 1 FROM actionable_items i WHERE i.entry_id = e.id AND $${params.length} = ANY(i.tags))`); }
  if (kind)    { params.push(kind);    where.push(`EXISTS (SELECT 1 FROM actionable_items i WHERE i.entry_id = e.id AND i.kind = $${params.length})`); }
  if (since)   { params.push(since);   where.push(`e.captured_at >= $${params.length}::timestamptz`); }
  if (until)   { params.push(until);   where.push(`e.captured_at <= $${params.length}::timestamptz`); }

  const rankParts = [];
  if (query) {
    params.push(query);
    rankParts.push(`ts_rank(e.search_tsv, websearch_to_tsquery('english', $${params.length}))`);
  }
  if (vec) {
    params.push(vecLiteral(vec));
    // Guard the NULL: entries saved while embeddings were unavailable must not
    // sort as perfect matches.
    rankParts.push(`COALESCE(1 - (e.embedding <=> $${params.length}::vector), 0)`);
  }
  const rankExpr = rankParts.length ? rankParts.join(' + ') : '0';

  params.push(limit, offset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const { rows } = await pool.query(
    `SELECT e.id, e.title, e.summary, e.captured_at, e.doc_url, e.image_url,
            e.image_description, e.transcript,
            (${rankExpr}) AS score,
            COALESCE(
              (SELECT json_agg(json_build_object(
                  'id', i.id, 'kind', i.kind, 'text', i.text, 'project', i.project,
                  'tags', i.tags, 'priority', i.priority, 'due_at', i.due_at, 'done', i.done)
                ORDER BY i.position)
                 FROM actionable_items i WHERE i.entry_id = e.id),
              '[]'::json) AS items
       FROM actionable_entries e
      WHERE ${where.join(' AND ')}
      ORDER BY score DESC, e.captured_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    summary: r.summary,
    capturedAt: r.captured_at?.toISOString?.() || null,
    docUrl: r.doc_url,
    imageUrl: r.image_url,
    imageDescription: r.image_description,
    score: Number(r.score) || 0,
    items: r.items || [],
    snippet: makeSnippet(r.transcript, query),
  }));
}

// Show the words AROUND the hit, so a result is recognisable without opening it.
function makeSnippet(transcript, query, radius = 90) {
  const t = String(transcript || '');
  if (!t) return '';
  if (!query) return t.slice(0, radius * 2) + (t.length > radius * 2 ? '…' : '');
  const idx = t.toLowerCase().indexOf(query.toLowerCase().split(/\s+/)[0] || '');
  if (idx === -1) return t.slice(0, radius * 2) + (t.length > radius * 2 ? '…' : '');
  const start = Math.max(0, idx - radius);
  const end = Math.min(t.length, idx + radius);
  return (start > 0 ? '…' : '') + t.slice(start, end).trim() + (end < t.length ? '…' : '');
}

export async function getEntry(userId, entryId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM actionable_entries WHERE user_id = $1 AND id = $2`,
    [userId, entryId]
  );
  if (!rows.length) return null;
  const { rows: items } = await pool.query(
    `SELECT id, position, kind, text, detail, project, tags, priority,
            due_raw, due_at, phone_action, done, done_at
       FROM actionable_items WHERE entry_id = $1 ORDER BY position`,
    [entryId]
  );
  return { ...rows[0], items };
}

export async function setItemDone(userId, itemId, done) {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE actionable_items
        SET done = $3, done_at = CASE WHEN $3 THEN now() ELSE NULL END
      WHERE user_id = $1 AND id = $2
      RETURNING id, done, done_at`,
    [userId, itemId, Boolean(done)]
  );
  return rows[0] || null;
}

// The open-work feed: everything not yet done, worst-overdue first.
export async function listOpenItems(userId, { project = null, limit = 100 } = {}) {
  const pool = getPool();
  const params = [userId];
  let projFilter = '';
  if (project) { params.push(project); projFilter = `AND i.project = $${params.length}`; }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT i.id, i.kind, i.text, i.detail, i.project, i.tags, i.priority,
            i.due_at, i.due_raw, i.phone_action, e.id AS entry_id, e.title AS entry_title,
            e.captured_at
       FROM actionable_items i
       JOIN actionable_entries e ON e.id = i.entry_id
      WHERE i.user_id = $1 AND i.done = false
        AND i.kind IN ('task','blocker','purchase','question')
        ${projFilter}
      ORDER BY (i.due_at IS NULL), i.due_at ASC,
               CASE i.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
               e.captured_at DESC
      LIMIT $${params.length}`,
    params
  );
  return rows;
}
