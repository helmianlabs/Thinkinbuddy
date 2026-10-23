// api/media-gallery.js — gallery + semantic recall for generated media.
//
// HTTP CONTRACT:
//   GET /api/media-gallery?userId=...&limit=30&type=all
//     → { userId, items: [{id,type,blobUrl,caption,createdAt,score}] }
//     → Returns past media for this user, newest first (no query = recency rank).
//
//   GET /api/media-gallery?userId=...&query=sunset+beach&limit=5
//     → Same shape but ranked by cosine similarity to `query` + recency bonus.
//     → Used when the assistant is asked "show me the image of X".
//
// TENANT SCOPING (audit §2 gap 12 — final sweep): in COMPAT mode (no
// SESSION_SECRET, today's live deployment) the userId query parameter
// keys the lookup exactly as before. In ENFORCED mode (SESSION_SECRET
// set) a valid tenant session is REQUIRED (401 without one), the
// session's tenant replaces the caller-supplied userId as the effective
// key, and retrieveMedia additionally filters memory_items by
// tenant_id — another tenant's media cannot come back.

import { applyBrowserCors } from '../../lib/security.js';
import { retrieveMedia } from '../../lib/mediaMemory.js';
import { resolveScopedRequestIdentity } from '../../lib/tenant.js';

export default async function handler(req, res) {
  applyBrowserCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const scoped = resolveScopedRequestIdentity(req, res, req.query?.userId);
  if (!scoped.ok) return; // enforced mode: requireTenant wrote the 401
  const userId = scoped.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const query     = (req.query?.query    || '').trim() || null;
  const limit     = Math.min(Number(req.query?.limit || 30), 100);
  const mediaType = ['image', 'video'].includes(req.query?.type) ? req.query.type : 'all';

  try {
    const items = await retrieveMedia({ userId, query, limit, mediaType, tenantId: scoped.tenantId });
    return res.status(200).json({ userId, items });
  } catch (err) {
    console.error('[media-gallery] error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'gallery fetch failed' });
  }
}
