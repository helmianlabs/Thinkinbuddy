// api/actionable-integrations.js
// ---------------------------------------------------------------------------
// One route behind the whole Integrations screen.
//
//   GET    ?userId=troy                          → every service + connected state
//   GET    ?userId=troy&action=start&provider=x  → { authUrl } for a one-tap connect
//   POST   { userId, provider, url }             → save a webhook / script URL
//   POST   { userId, provider, entryId, itemIds? } → push an entry to a service
//   DELETE ?userId=troy&provider=x               → disconnect
//
// The app never sees a token. For OAuth providers it opens `authUrl` in a
// browser and polls this route until `connected` flips true.
// ---------------------------------------------------------------------------

import { listProviders, getProvider } from '../lib/actionable/integrations/registry.js';
import {
  listConnections, saveUrlConnection, deleteConnection, getUsableConnection,
} from '../lib/actionable/integrations/store.js';
import { makeState, googleStatus, disconnectGoogle } from '../lib/actionable/google-auth.js';
import { getEntry, listProjects, getSettings } from '../lib/actionable/db.js';
import { cors, requireAuth, readQuery } from '../lib/actionable/http.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!requireAuth(req, res)) return;

  const userId = readQuery(req, 'userId') || req.body?.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    if (req.method === 'GET') {
      const action = readQuery(req, 'action', 'list');

      if (action === 'start') {
        const id = readQuery(req, 'provider');
        const provider = getProvider(id);
        if (!provider) return res.status(404).json({ error: `Unknown service "${id}"` });
        if (provider.kind !== 'oauth') {
          return res.status(400).json({ error: `${provider.name} is connected by pasting a URL, not by signing in.` });
        }
        if (!provider.isConfigured()) {
          return res.status(503).json({
            error: `${provider.name} is not set up on the server yet.`,
            setupGuide: 'docs/ACTIONABLE_SETUP.md',
          });
        }
        if (!process.env.ACTIONABLE_STATE_SECRET) {
          return res.status(503).json({ error: 'ACTIONABLE_STATE_SECRET is not set — it signs the OAuth state and is required.' });
        }
        return res.status(200).json({ ok: true, authUrl: provider.buildAuthUrl(makeState(userId, provider.id)) });
      }

      // Google's connection predates the generic table, so its status comes from
      // its own record. Everything else comes from actionable_connections.
      const [conns, g] = await Promise.all([listConnections(userId), googleStatus(userId)]);
      const byId = new Map(conns.map(c => [c.provider, c]));

      const services = listProviders().map(p => {
        if (p.id === 'google-docs') {
          return { ...p, connected: Boolean(g.connected), accountLabel: g.email || null, targetUrl: null };
        }
        const c = byId.get(p.id);
        return {
          ...p,
          connected: Boolean(c),
          accountLabel: c?.accountLabel || null,
          targetUrl: c?.targetUrl || null,
        };
      });

      return res.status(200).json({ ok: true, services });
    }

    if (req.method === 'DELETE') {
      const id = readQuery(req, 'provider');
      if (!id) return res.status(400).json({ error: 'provider required' });
      if (id === 'google-docs') {
        await disconnectGoogle(userId);
      } else {
        await deleteConnection(userId, id);
      }
      return res.status(200).json({ ok: true, connected: false });
    }

    if (req.method === 'POST') {
      const { provider: id, url, entryId, itemIds } = req.body || {};
      const provider = getProvider(id);
      if (!provider) return res.status(404).json({ error: `Unknown service "${id}"` });

      // --- save a URL-style connection -----------------------------------
      if (url !== undefined) {
        if (provider.kind === 'oauth') {
          return res.status(400).json({ error: `${provider.name} is connected by signing in, not by pasting a URL.` });
        }
        const clean = String(url || '').trim();
        if (!clean) {
          await deleteConnection(userId, provider.id);
          return res.status(200).json({ ok: true, connected: false });
        }
        if (!/^https:\/\//i.test(clean)) {
          return res.status(400).json({ error: 'That must be a full https:// URL.' });
        }
        await saveUrlConnection(userId, provider.id, clean);
        return res.status(200).json({ ok: true, connected: true });
      }

      // --- push an entry --------------------------------------------------
      if (!entryId) return res.status(400).json({ error: 'entryId required' });

      const entry = await getEntry(userId, entryId);
      if (!entry) return res.status(404).json({ error: 'entry not found' });

      const conn = provider.id === 'google-docs'
        ? { accessToken: 'via-google-record', targetUrl: null, config: {} }
        : await getUsableConnection(userId, provider.id);
      if (!conn) return res.status(400).json({ error: `${provider.name} is not connected.` });

      // Rebuild the entry shape the providers expect. getEntry returns DB rows,
      // where items carry due_raw/due_at rather than the nested `due` object.
      const allItems = (entry.items || []).map(i => ({
        kind: i.kind, text: i.text, detail: i.detail || '',
        project: i.project, tags: i.tags || [], priority: i.priority,
        due: (i.due_raw || i.due_at) ? { raw: i.due_raw, iso: i.due_at ? new Date(i.due_at).toISOString() : null } : null,
        phone_action: i.phone_action || { kind: 'none' },
        id: i.id,
      }));

      // Default to what this service can actually use, so pushing a mixed dump
      // to a task manager does not create four "notes" as tasks.
      const chosen = Array.isArray(itemIds) && itemIds.length
        ? allItems.filter(i => itemIds.includes(i.id))
        : allItems.filter(i => provider.accepts.includes(i.kind));

      if (!chosen.length) {
        return res.status(400).json({
          error: `Nothing in this entry suits ${provider.name} (it takes ${provider.accepts.join(', ')}).`,
        });
      }

      const [projects, settings] = await Promise.all([listProjects(userId), getSettings(userId)]);

      const out = await provider.push({
        userId,
        entry: {
          title: entry.title, summary: entry.summary,
          items: allItems, people: entry.people || [],
          numbers: entry.numbers || [], open_questions: entry.open_questions || [],
          transcription_repairs: entry.transcription_repairs || [], unclear: entry.unclear || [],
          image_text: entry.image_text, image_description: entry.image_description,
        },
        items: chosen,
        transcript: entry.transcript || '',
        accessToken: conn.accessToken,
        targetUrl: conn.targetUrl,
        config: conn.config,
        timezone: settings.timezone,
        capturedAt: entry.captured_at || new Date(),
        projects,
        folderId: settings.doc_folder_id,
      });

      return res.status(out.ok ? 200 : 502).json({ ok: out.ok, ...out, provider: provider.id });
    }

    return res.status(405).json({ error: 'GET, POST or DELETE' });

  } catch (err) {
    console.error('[actionable-integrations]', err);
    return res.status(500).json({ error: err.message });
  }
}
