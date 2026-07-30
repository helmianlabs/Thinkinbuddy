import { resolveKey, missingKeyError } from '../lib/userKeys.js';

// Fallback voice, used when the caller names none. Unchanged from the
// original hardcoded value so existing callers keep the same voice.
const DEFAULT_VOICE_ID = 'nPczCjzI2devNBz1zQrb';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Key-ELEVENLABS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  let { text, voiceId: requestedVoiceId } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });

  // Pronunciation corrections
  text = text.replace(/shoshone/gi, 'sho-shown');

  const { key: apiKey } = resolveKey(req, 'ELEVENLABS_API_KEY');
  if (!apiKey) return res.status(400).json(missingKeyError('ELEVENLABS_API_KEY'));

  // Accept only an id-shaped value — this is interpolated into the URL.
  const voiceId = (typeof requestedVoiceId === 'string' && /^[A-Za-z0-9]{16,40}$/.test(requestedVoiceId))
    ? requestedVoiceId
    : DEFAULT_VOICE_ID;

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: 1.0 }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    return res.status(response.status).json({ error: err });
  }

  const audioBuffer = await response.arrayBuffer();
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', audioBuffer.byteLength);
  res.send(Buffer.from(audioBuffer));
}
