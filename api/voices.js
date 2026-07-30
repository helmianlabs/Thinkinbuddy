// api/voices.js — list the ElevenLabs voices available to this account.
//
// Exists so the Settings → Voice picker can show real voices without ever
// putting an ElevenLabs key in the browser bundle. The key comes either from
// the caller's own X-User-Key-ELEVENLABS header (their localStorage key) or
// from the server's ELEVENLABS_API_KEY — see lib/userKeys.js.
//
// Returns a deliberately narrow projection (id, name, category) rather than
// ElevenLabs' full payload: the picker needs nothing else, and the response
// is public to anyone with the app open.

import { resolveKey, missingKeyError } from '../lib/userKeys.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Key-ELEVENLABS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { key } = resolveKey(req, 'ELEVENLABS_API_KEY');
  if (!key) return res.status(400).json(missingKeyError('ELEVENLABS_API_KEY'));

  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': key },
    });

    if (!r.ok) {
      // Surface ElevenLabs' status, never the key that produced it.
      const detail = await r.text().catch(() => '');
      return res.status(r.status).json({
        error: `ElevenLabs returned ${r.status}`,
        detail: detail.slice(0, 300),
      });
    }

    const data = await r.json();
    const voices = (data?.voices || []).map(v => ({
      voice_id: v.voice_id,
      name: v.name,
      category: v.category || null,
    }));

    // Voice lists change rarely; let the browser hold one for a few minutes.
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).json({ voices });
  } catch (err) {
    console.error('[voices] failed:', err?.message || err);
    return res.status(500).json({ error: 'Failed to reach ElevenLabs' });
  }
}
