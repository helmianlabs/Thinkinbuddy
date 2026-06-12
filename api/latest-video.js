// api/latest-video.js — returns the most recently generated video for a user,
// AND finalizes any pending Sora jobs (kick-and-poll architecture).
//
// Why finalize here: video generation takes minutes; a single serverless
// function can't wait that long (plan timeout → 504). So /api/video-sora just
// STARTS the job and drops a `pending-<jobId>.json` marker. This endpoint —
// polled by the widget every 3s — checks each pending job's status with
// OpenAI, downloads the MP4 to Blob when complete, clears the marker, then
// returns the newest finished video. Each call is short (status check + at
// most one download), so it always fits inside the function timeout.

import { list, put, del } from '@vercel/blob';
import { saveMediaMemory } from '../lib/mediaMemory.js';

const blobPrefix = (userId) => `thinkinbuddy/videos/${userId}/`;

function timestampFromKey(pathname) {
  const m = pathname.match(/\/(\d+)\.mp4$/);
  return m ? Number(m[1]) : 0;
}

// Finalize pending Sora jobs: for each pending-*.json marker, ask OpenAI if the
// job is done; if so download the MP4 to Blob (as <ts>.mp4 + <ts>.meta.json)
// and delete the marker. Failed/expired jobs just get their marker deleted.
async function finalizePending(blobs, token, apiKey) {
  if (!apiKey) return; // no key → can't finalize; nothing to do
  const markers = (blobs || []).filter((b) => /\/pending-[^/]+\.json$/.test(b.pathname));
  for (const marker of markers) {
    let meta;
    try {
      const r = await fetch(marker.url);
      if (!r.ok) continue;
      meta = await r.json();
    } catch {
      continue;
    }
    const jobId = meta?.jobId;
    if (!jobId) {
      await del(marker.url, { token }).catch(() => {});
      continue;
    }
    // Stale marker safety valve: drop anything older than 30 min.
    if (meta.createdAt && Date.now() - meta.createdAt > 30 * 60 * 1000) {
      await del(marker.url, { token }).catch(() => {});
      continue;
    }
    let status;
    try {
      const poll = await fetch(`https://api.openai.com/v1/videos/${jobId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!poll.ok) continue;
      const job = await poll.json();
      status = job?.status;
    } catch {
      continue;
    }
    if (status === 'failed') {
      await del(marker.url, { token }).catch(() => {});
      continue;
    }
    if (status !== 'completed') {
      continue; // still queued/in_progress — leave the marker, try next poll
    }
    // Completed → download MP4 + write final blobs, then clear the marker.
    try {
      const contentRes = await fetch(`https://api.openai.com/v1/videos/${jobId}/content`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!contentRes.ok) continue;
      const buf = Buffer.from(await contentRes.arrayBuffer());
      const ts = Date.now();
      const userId = meta.userId || 'anonymous';
      const finalBlob = await put(`${blobPrefix(userId)}${ts}.mp4`, buf, {
        access: 'public',
        contentType: 'video/mp4',
        addRandomSuffix: false,
        token,
      });
      await put(
        `${blobPrefix(userId)}${ts}.meta.json`,
        JSON.stringify({ prompt: meta.prompt || '', provider: meta.provider || 'sora' }),
        { access: 'public', contentType: 'application/json', addRandomSuffix: false, token },
      );
      // Persist to Neon memory so this Sora video is recallable by semantic search.
      // Mirrors the Runway path in api/video.js:146 — without this, kick-and-poll
      // (Sora) videos finish in Blob but are never saved to memory_items.
      if (meta.prompt) {
        saveMediaMemory({ userId, type: 'video', blobUrl: finalBlob.url, prompt: meta.prompt, createdAt: ts }).catch(
          (e) => console.error('[latest-video] saveMediaMemory failed (non-fatal):', e?.message || e),
        );
      }
      await del(marker.url, { token }).catch(() => {});
    } catch (err) {
      console.error('[latest-video] finalize failed for', jobId, err?.message || err);
    }
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = req.query?.userId || 'anonymous';
  const since = Number(req.query?.since || 0);

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!token) return res.status(200).json({ url: null });

  try {
    let { blobs } = await list({ prefix: blobPrefix(userId), limit: 50, token });

    // Finalize any pending Sora jobs first, then re-list so a just-completed
    // video is visible on this same poll.
    const hadPending = (blobs || []).some((b) => /\/pending-[^/]+\.json$/.test(b.pathname));
    if (hadPending) {
      await finalizePending(blobs, token, apiKey);
      ({ blobs } = await list({ prefix: blobPrefix(userId), limit: 50, token }));
    }

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
