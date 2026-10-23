// api/latest-video.js — returns the most recently generated video for a user.
//
// Videos are written to Vercel Blob by the generation handlers as
// thinkinbuddy/videos/<userId>/<ts>.mp4 (+ an optional <ts>.meta.json
// sidecar carrying the prompt). This endpoint serves the newest .mp4
// whose timestamp is newer than the caller's `since`.
//
// PROVIDERS (final sweep): this endpoint used to ALSO finalize pending
// Sora jobs (kick-and-poll): /api/video-sora started a job and dropped a
// `pending-<jobId>.json` marker here, and each poll asked OpenAI's
// Videos API for the result. That API was retired on 2026-09-24, the
// video-sora route is deleted, and the finalizer went with it — nothing
// here calls a retired API. The surviving video providers (Runway, Veo,
// HeyGen) finish through their own handlers. Any ancient pending-*.json
// markers left in Blob are simply ignored.
//
// TENANT SCOPING (audit §2 gap 12 — final sweep): COMPAT mode (no
// SESSION_SECRET) is unchanged — userId query parameter, 'anonymous'
// default. ENFORCED mode requires a valid tenant session (401 without
// one) and the Blob prefix is the SESSION tenant's id, never a
// caller-supplied value.

import { list } from '@vercel/blob';
import { resolveScopedRequestIdentity } from '../../lib/tenant.js';

const blobPrefix = (userId) => `thinkinbuddy/videos/${userId}/`;

function timestampFromKey(pathname) {
  const m = pathname.match(/\/(\d+)\.mp4$/);
  return m ? Number(m[1]) : 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const scoped = resolveScopedRequestIdentity(req, res, req.query?.userId);
  if (!scoped.ok) return; // enforced mode: requireTenant wrote the 401
  const userId = scoped.userId || 'anonymous';
  const since = Number(req.query?.since || 0);

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return res.status(200).json({ url: null });

  try {
    const { blobs } = await list({ prefix: blobPrefix(userId), limit: 50, token });
    if (!blobs?.length) return res.status(200).json({ url: null });

    const mp4s = blobs.filter((b) => /\.mp4$/.test(b.pathname));
    if (!mp4s.length) return res.status(200).json({ url: null });
    mp4s.sort((a, b) => timestampFromKey(b.pathname) - timestampFromKey(a.pathname));
    const newest = mp4s[0];
    const timestamp = timestampFromKey(newest.pathname);

    if (timestamp <= since) {
      return res.status(200).json({ url: null });
    }

    let prompt = '';
    const sidecarPath = newest.pathname.replace(/\.mp4$/, '.meta.json');
    const sidecar = blobs.find((b) => b.pathname === sidecarPath);
    if (sidecar) {
      try {
        const r = await fetch(sidecar.url);
        if (r.ok) {
          const meta = await r.json();
          prompt = meta?.prompt || '';
        }
      } catch (err) {
        // non-essential
      }
    }

    return res.status(200).json({ url: newest.url, timestamp, prompt });
  } catch (err) {
    console.error('[latest-video] list failed:', err?.message || err);
    return res.status(200).json({ url: null });
  }
}
