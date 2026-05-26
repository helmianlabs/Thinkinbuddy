// api/latest-video.js — returns the most recently generated video for a user.
//
// Mirrors /api/latest-image. Reads from Vercel Blob under
// thinkinbuddy/videos/<userId>/<ts>.mp4 with optional <ts>.meta.json sidecar.

import { list } from '@vercel/blob';

const blobPrefix = (userId) => `thinkinbuddy/videos/${userId}/`;

function timestampFromKey(pathname) {
  const m = pathname.match(/\/(\d+)\.mp4$/);
  return m ? Number(m[1]) : 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = req.query?.userId || 'anonymous';
  const since = Number(req.query?.since || 0);

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return res.status(200).json({ url: null });

  try {
    const { blobs } = await list({ prefix: blobPrefix(userId), limit: 20, token });
    if (!blobs?.length) return res.status(200).json({ url: null });

    const mp4s = blobs.filter(b => /\.mp4$/.test(b.pathname));
    if (!mp4s.length) return res.status(200).json({ url: null });
    mp4s.sort((a, b) => timestampFromKey(b.pathname) - timestampFromKey(a.pathname));
    const newest = mp4s[0];
    const timestamp = timestampFromKey(newest.pathname);

    if (timestamp <= since) {
      return res.status(200).json({ url: null });
    }

    let prompt = '';
    const sidecarPath = newest.pathname.replace(/\.mp4$/, '.meta.json');
    const sidecar = blobs.find(b => b.pathname === sidecarPath);
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
