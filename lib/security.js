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

// requireBrowserFetch — hardened gate for endpoints a BROWSER calls.
//
// ─── READ THIS FIRST: THIS IS NOT AUTHENTICATION ────────────────────────────
// It raises the COST of abuse. It does not prevent it. A determined caller sets
// these headers too — they are three extra strings in a curl command. Anyone
// reading this later must not record the endpoint as "protected" or "fixed".
// The only real fix is per-user authentication, which this app does not have:
// genUserId() (index.html:1003-1008) returns the hardcoded string 'troy' for
// every user on every device.
//
// WHAT IT ACTUALLY STOPS: the naive scripted caller. Origin alone did not even
// do that. Proven live 2026-07-30 against /api/chat:
//     curl -X POST .../api/chat -d '{}'                          -> 403
//     curl -X POST .../api/chat -H 'Origin: https://jarvis-troy.vercel.app' \
//          -d '{}'                                               -> 400
// One forged header turned a refusal into "messages required", i.e. straight
// through to parameter validation with a paid Anthropic call just past it.
// CORS is a browser instruction, not a server-side check — this file's own
// header has said so since it was written, at :8-13.
//
// WHY Sec-Fetch-* HELPS: they are FORBIDDEN header names. Page JavaScript
// cannot set or override them — the browser stamps them itself. So a real
// in-page fetch always carries them and a bare curl never does unless the
// caller knows to add them. Fail CLOSED when they are absent.
//
// KNOWN COST OF FAILING CLOSED: browsers that do not send Sec-Fetch-* are
// locked out. That is Safari before 16.4 (March 2023) and equivalents. Chrome,
// Edge, Firefox and the Capacitor Android WebView (Chromium) all send them.
// Accepted deliberately rather than falling open, because falling open on a
// missing header means any caller omits the header and walks in — which is the
// exact defect being fixed.
//
// CROSS-SITE IS ALLOWED ON PURPOSE: the Capacitor native app runs on
// https://localhost / capacitor://localhost and calls this API cross-origin, so
// its requests carry Sec-Fetch-Site: cross-site. Those origins are already in
// DEFAULT_ALLOWED_ORIGINS above, and the Origin allowlist is what constrains
// WHO may call; Sec-Fetch-* only evidences that a browser made the call.
// Requiring same-origin here would 403 the Android app.
export function requireBrowserFetch(req, res) {
  if (!applyBrowserCors(req, res)) {
    res.status(403).json({ error: 'Origin not allowed' });
    return false;
  }
  const h = req.headers || {};
  const site = h['sec-fetch-site'];
  const mode = h['sec-fetch-mode'];
  const dest = h['sec-fetch-dest'];

  // Absent => not a browser fetch (or a browser too old to vouch for it).
  if (!site || !mode || !dest) {
    res.status(403).json({ error: 'Not a browser request' });
    return false;
  }
  // 'none' means a user-initiated navigation (typed URL, bookmark), not a
  // fetch issued by a page. Real API traffic is never 'none'.
  if (site === 'none') {
    res.status(403).json({ error: 'Not a browser request' });
    return false;
  }
  // fetch()/XHR from a page produce mode cors|same-origin and dest empty.
  // A navigation, image load, script tag or form post produces something else,
  // and none of those are how this API is legitimately called.
  if (mode !== 'cors' && mode !== 'same-origin') {
    res.status(403).json({ error: 'Not a browser request' });
    return false;
  }
  if (dest !== 'empty') {
    res.status(403).json({ error: 'Not a browser request' });
    return false;
  }
  return true;
}

// requireToolAuth — the SAME secret check as requireWebhookSecret, but behind a
// rollout flag, for endpoints that TODAY are called only by the live ElevenLabs
// agent's tool webhooks (/api/search, /api/browse, /api/recall-memory).
//
// WHY A FLAG AND NOT A HARD GATE. Those tool webhooks do not send
// X-Webhook-Secret yet — that header has to be added to each tool's
// api_schema.request_headers on agent agent_4401kqcb0w2dey28c69zhchv7ayn
// first. Hard-gating them here would mean the next deploy silently breaks
// Troy's voice assistant: search_web, browse_url and recall_memory would all
// start returning 401 mid-call. So this defaults to OFF and the rollout is two
// steps, in this order:
//
//   1. Add the header to the three tools (see docs/TOOL_AUTH_ROLLOUT.md),
//      verify a live call still works.
//   2. Set ENFORCE_TOOL_AUTH=1 in Vercel. THIS is the step that actually
//      closes the hole. Until it happens the endpoints remain open.
//
// Deliberately inverted from requireWebhookSecret's closed-by-default stance
// (see this file's header). That inversion is the whole point — it buys a
// deploy that cannot break the voice — and it is why step 2 is not optional.
export function requireToolAuth(req, res) {
  if (process.env.ENFORCE_TOOL_AUTH !== '1') return true;
  return requireWebhookSecret(req, res);
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
