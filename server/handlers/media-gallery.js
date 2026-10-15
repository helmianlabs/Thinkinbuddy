// api/media-gallery.js — gallery + semantic recall for Mark's generated media.
//
// HTTP CONTRACT:
//   GET /api/media-gallery?userId=...&limit=30&type=all
//     → { userId, items: [{id,type,blobUrl,caption,createdAt,score}] }
//     → Returns ALL past media for this user, newest first (no query = recency rank).
//
//   GET /api/media-gallery?userId=...&query=sunset+beach&limit=5
//     → Same shape but ranked by cosine similarity to `query` + recency bonus.
//     → Used when Mark/the assistant is asked "show me the image of X".
//
// Both paths call retrieveMedia() from lib/mediaMemory.js which uses pgvector
// cosine distance (<=> operator) when a query embedding is available, or falls
// back to recency rank.  No auth gate: browser-side CORS open (same as /api/memory).
//
// The front-end gallery panel polls this with no query on load; it also calls it
// with a query when the user asks Mark to recall a specific image/video.

import { applyBrowserCors } from '../../lib/security.js';
import { retrieveMedia } from '../../lib/mediaMemory.js';

export default async function handler(req, res) {
  applyBrowserCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const userId = req.query?.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const query     = (req.query?.query    || '').trim() || null;
  const limit     = Math.min(Number(req.query?.limit || 30), 100);
  const mediaType = ['image', 'video'].includes(req.query?.type) ? req.query.type : 'all';

  try {
    const items = await retrieveMedia({ userId, query, limit, mediaType });
    return res.status(200).json({ userId, items });
  } catch (err) {
    console.error('[media-gallery] error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'gallery fetch failed' });
  }
}
