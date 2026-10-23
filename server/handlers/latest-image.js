// api/latest-image.js — returns the most recently generated image for a user.
//
// Reads from Vercel Blob (where /api/image now writes), so this works across
// Vercel cold starts and horizontally-scaled function instances. The previous
// version used an in-process `global.__latestImage`, which was lost on cold
// start and never shared between instances.
//
// Query: ?userId=<id>&since=<ms>   (since is optional; widget passes its last
//                                   seen timestamp to avoid re-rendering the
//                                   same image)
//
// TENANT SCOPING (audit §2 gap 12 — final sweep): COMPAT mode (no
// SESSION_SECRET) is unchanged — userId query parameter, 'anonymous'
// default. ENFORCED mode requires a valid tenant session (401 without
// one) and the Blob prefix is the SESSION tenant's id, never a
// caller-supplied value, so one tenant cannot poll another's prefix.

import { list } from '@vercel/blob';
import { resolveScopedRequestIdentity } from '../../lib/tenant.js';

const blobPrefix = (userId) => `thinkinbuddy/images/${userId}/`;

// Strip the timestamp filename out of a blob key: ".../1762551111111.png" -> 1762551111111
function timestampFromKey(pathname) {
  const m = pathname.match(/\/(\d+)\.png$/);
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
    const { blobs } = await list({ prefix: blobPrefix(userId), limit: 20, token });
    if (!blobs?.length) return res.status(200).json({ url: null });

    // Newest .png first. Sidecar .meta.json files have ts=0 so they sort last.
    const pngs = blobs.filter(b => /\.png$/.test(b.pathname));
    if (!pngs.length) return res.status(200).json({ url: null });
    pngs.sort((a, b) => timestampFromKey(b.pathname) - timestampFromKey(a.pathname));
    const newest = pngs[0];
    const timestamp = timestampFromKey(newest.pathname);

    if (timestamp <= since) {
      return res.status(200).json({ url: null });
    }

    // Look up matching sidecar for caption. Cheap — already in the list result.
    let prompt = '';
    const sidecarPath = newest.pathname.replace(/\.png$/, '.meta.json');
    const sidecar = blobs.find(b => b.pathname === sidecarPath);
    if (sidecar) {
      try {
        const r = await fetch(sidecar.url);
        if (r.ok) {
          const meta = await r.json();
          prompt = meta?.prompt || '';
        }
      } catch (err) {
        // Caption is non-essential; image still renders without it.
      }
    }

    return res.status(200).json({ url: newest.url, timestamp, prompt });
  } catch (err) {
    console.error('[latest-image] list failed:', err?.message || err);
    return res.status(200).json({ url: null });
  }
}
