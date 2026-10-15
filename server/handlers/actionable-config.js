// api/actionable-config.js
// ---------------------------------------------------------------------------
// Projects (the editable category set) and settings.
//
// This route is what makes "categories are data, not code" true end to end: the
// user renames, adds and archives their own projects here, and lib/actionable/prompt.js
// reads that list at extraction time. Nothing needs a redeploy to change how a
// dump gets sorted.
//
//   GET    ?userId=troy                       → { projects, settings, google }
//   POST   { userId, project:{slug,label,hint,color} }   → add / rename
//   DELETE ?userId=troy&slug=business         → archive (never destroys history)
//   PATCH  { userId, settings:{...} }         → timezone, webhooks, sheet, threshold
// ---------------------------------------------------------------------------

import {
  listProjects, upsertProject, archiveProject,
  getSettings, saveSettings, ensureSeedProjects, listKnownTags,
} from '../../lib/actionable/db.js';
import { googleStatus, isGoogleConfigured } from '../../lib/actionable/google-auth.js';
import { cors, requireAuth, readQuery } from '../../lib/actionable/http.js';

const SETTABLE = ['timezone', 'sheets_webhook', 'docs_webhook', 'sheet_id', 'numeric_threshold', 'doc_folder_id'];

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!requireAuth(req, res)) return;

  const userId = readQuery(req, 'userId') || req.body?.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    await ensureSeedProjects(userId);

    if (req.method === 'GET') {
      const [projects, tags, settings, google] = await Promise.all([
        listProjects(userId), listKnownTags(userId), getSettings(userId), googleStatus(userId),
      ]);
      return res.status(200).json({
        ok: true, projects, tags, settings,
        google: { ...google, configured: isGoogleConfigured() },
      });
    }

    if (req.method === 'POST') {
      const p = req.body?.project;
      if (!p?.label) return res.status(400).json({ error: 'project.label required' });
      const slug = String(p.slug || p.label).toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!slug) return res.status(400).json({ error: 'project label must contain letters or numbers' });
      const saved = await upsertProject(userId, {
        slug, label: String(p.label).slice(0, 60),
        hint: String(p.hint || '').slice(0, 200),
        color: p.color || null,
        sortOrder: Number.isFinite(Number(p.sortOrder)) ? Number(p.sortOrder) : 100,
      });
      return res.status(200).json({ ok: true, project: saved });
    }

    if (req.method === 'DELETE') {
      const slug = readQuery(req, 'slug');
      if (!slug) return res.status(400).json({ error: 'slug required' });
      const out = await archiveProject(userId, slug);
      return res.status(200).json({ ok: true, ...out });
    }

    if (req.method === 'PATCH') {
      const patch = {};
      for (const k of SETTABLE) {
        if (req.body?.settings && k in req.body.settings) patch[k] = req.body.settings[k];
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: `settings must include one of: ${SETTABLE.join(', ')}` });
      if ('numeric_threshold' in patch) {
        const n = Number(patch.numeric_threshold);
        patch.numeric_threshold = Number.isFinite(n) ? Math.max(1, Math.min(50, Math.trunc(n))) : 3;
      }
      const settings = await saveSettings(userId, patch);
      return res.status(200).json({ ok: true, settings });
    }

    return res.status(405).json({ error: 'GET, POST, PATCH or DELETE' });

  } catch (err) {
    console.error('[actionable-config]', err);
    return res.status(500).json({ error: err.message });
  }
}
