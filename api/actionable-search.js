// api/actionable-search.js
// ---------------------------------------------------------------------------
// "Find that thing I dictated last week."
//
//   GET  /api/actionable-search?userId=troy&q=drainage
//   GET  /api/actionable-search?userId=troy&project=business&since=2026-07-01
//   GET  /api/actionable-search?userId=troy&view=open           → open task feed
//   GET  /api/actionable-search?userId=troy&entryId=<uuid>      → one full entry
//   PATCH /api/actionable-search  { userId, itemId, done }      → tick an item off
//
// Natural-language relative ranges are resolved server-side, because "last week"
// is what he will actually type into the box.
// ---------------------------------------------------------------------------

import { searchEntries, getEntry, listOpenItems, setItemDone, listProjects, listKnownTags } from '../lib/actionable/db.js';
import { cors, requireAuth, readQuery } from '../lib/actionable/http.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!requireAuth(req, res)) return;

  try {
    if (req.method === 'PATCH') {
      const { userId, itemId, done } = req.body || {};
      if (!userId || !itemId) return res.status(400).json({ error: 'userId and itemId required' });
      const updated = await setItemDone(userId, itemId, done);
      if (!updated) return res.status(404).json({ error: 'item not found' });
      return res.status(200).json({ ok: true, item: updated });
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'GET or PATCH only' });

    const userId = readQuery(req, 'userId');
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const entryId = readQuery(req, 'entryId');
    if (entryId) {
      const entry = await getEntry(userId, entryId);
      if (!entry) return res.status(404).json({ error: 'entry not found' });
      return res.status(200).json({ ok: true, entry });
    }

    if (readQuery(req, 'view') === 'open') {
      const items = await listOpenItems(userId, {
        project: readQuery(req, 'project'),
        limit: Math.min(200, Number(readQuery(req, 'limit', 100)) || 100),
      });
      return res.status(200).json({ ok: true, items });
    }

    if (readQuery(req, 'view') === 'facets') {
      const [projects, tags] = await Promise.all([listProjects(userId), listKnownTags(userId)]);
      return res.status(200).json({ ok: true, projects, tags });
    }

    const q = readQuery(req, 'q', '') || '';
    const range = resolveRange(readQuery(req, 'range'), readQuery(req, 'since'), readQuery(req, 'until'));

    const results = await searchEntries(userId, {
      q,
      project: readQuery(req, 'project'),
      tag: readQuery(req, 'tag'),
      kind: readQuery(req, 'kind'),
      since: range.since,
      until: range.until,
      limit: Math.min(100, Number(readQuery(req, 'limit', 25)) || 25),
      offset: Number(readQuery(req, 'offset', 0)) || 0,
    });

    return res.status(200).json({ ok: true, query: q, range, count: results.length, results });

  } catch (err) {
    console.error('[actionable-search]', err);
    return res.status(500).json({ error: err.message });
  }
}

// "last week" / "yesterday" / "this month" → concrete bounds.
// Explicit since/until always win over a named range.
function resolveRange(range, since, until) {
  if (since || until) return { since: since || null, until: until || null, label: 'custom' };
  if (!range) return { since: null, until: null, label: 'all' };

  const now = new Date();
  const day = 86400000;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (String(range).toLowerCase().replace(/\s+/g, '-')) {
    case 'today':
      return { since: startOfToday.toISOString(), until: null, label: 'today' };
    case 'yesterday':
      return {
        since: new Date(startOfToday.getTime() - day).toISOString(),
        until: startOfToday.toISOString(),
        label: 'yesterday',
      };
    case 'last-week':
    case 'past-week':
    case 'this-week':
      return { since: new Date(startOfToday.getTime() - 7 * day).toISOString(), until: null, label: 'last 7 days' };
    case 'last-month':
    case 'past-month':
    case 'this-month':
      return { since: new Date(startOfToday.getTime() - 30 * day).toISOString(), until: null, label: 'last 30 days' };
    case 'last-90':
    case 'quarter':
      return { since: new Date(startOfToday.getTime() - 90 * day).toISOString(), until: null, label: 'last 90 days' };
    default:
      return { since: null, until: null, label: 'all' };
  }
}
