// lib/security.js — request gating for the jarvis-troy serverless API.
//
// Two gate styles, one helper each:
//
//   applyBrowserCors(req, res)
//     For endpoints called by a real browser from our own front-ends
//     (desktop.html / index.html on jarvis-troy.vercel.app). Replaces
//     `Access-Control-Allow-Origin: *` with an explicit allowlist driven
//     by the ALLOWED_ORIGINS env var (comma-separated). Returns true if
//     the origin was honored. If the request is an OPTIONS preflight the
//     caller should still 200-end after this returns.
//
//   requireWebhookSecret(req, res)
//     For endpoints called server-to-server by ElevenLabs as agent tool
//     webhooks (image, video). ElevenLabs servers don't send a browser
//     Origin header, so CORS is the wrong gate — instead require an
//     X-Webhook-Secret header that matches WEBHOOK_SECRET. Returns true
//     if the secret matched; otherwise it has already written a 401 to
//     `res` and the caller should return immediately.
//
// Both helpers are SAFE BY DEFAULT — if the env var is missing the gate
// CLOSES (no origins honored, no secret accepted). This prevents a
// silent regression where a missing env var would re-open the hole.
//
// Env vars (set in Vercel project settings before deploy):
//   ALLOWED_ORIGINS  comma-separated list. Example:
//                    "https://jarvis-troy.vercel.app,http://localhost:5173"
//   WEBHOOK_SECRET   long random string shared with the ElevenLabs agent
//                    tool config (Authorization-style custom header).

const DEFAULT_ALLOWED_ORIGINS = [
  // Hard-coded fallback so a forgotten env var doesn't lock Troy out of
  // his own production widget. If you rename the Vercel project, update
  // this AND the ALLOWED_ORIGINS env var. Localhost included so vite
  // dev (npm run dev → :5173) keeps working without env tweaks.
  'https://jarvis-troy.vercel.app',
  'https://thinkinbuddy.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  // Capacitor native APK (bundled mode): the Android WebView serves the
  // bundled assets from https://localhost by default (androidScheme:'https'),
  // so cross-origin fetches TO the Vercel API carry this Origin. iOS uses
  // capacitor://localhost. Both must be allowed or the native app's
  // browser-CORS calls (chat.js etc.) 403.
  'https://localhost',
  'capacitor://localhost',
];

function getAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || '';
  const fromEnv = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;
  return DEFAULT_ALLOWED_ORIGINS;
}

export function applyBrowserCors(req, res) {
  const allowed = getAllowedOrigins();
  const origin = req.headers?.origin || '';

  // Always lock methods + headers regardless of origin match.
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    return true;
  }
  // Don't set the header at all when the origin isn't allowed — that's
  // what tells the browser to block the response. (Setting it to a
  // bogus value would still leak the route's existence less clearly.)
  return false;
}

export function requireWebhookSecret(req, res) {
  const expected = process.env.WEBHOOK_SECRET || '';
  // Closed-by-default: no env var means no caller is authorized.
  if (!expected) {
    res.status(503).json({ result: 'Server not configured: WEBHOOK_SECRET missing' });
    return false;
  }
  const provided = req.headers?.['x-webhook-secret'] || '';
  // Constant-time-ish compare — short-circuit on length mismatch then
  // walk bytes. Node has timingSafeEqual but this stays import-free.
  if (provided.length !== expected.length) {
    res.status(401).json({ result: 'Unauthorized' });
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  if (diff !== 0) {
    res.status(401).json({ result: 'Unauthorized' });
    return false;
  }
  return true;
}
