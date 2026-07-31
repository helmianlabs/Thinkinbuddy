// lib/actionable/http.js
// ---------------------------------------------------------------------------
// Shared CORS + auth guard for the Actionable routes.
//
// 🔴 SECURITY NOTE, STATED PLAINLY: the existing routes in this app (api/memory.js:585-611,
// api/diary.js:7-12) identify the caller by a `userId` STRING IN THE REQUEST and
// perform no authentication. Anyone who guesses a userId can read that user's
// data. For a memory store of chat facts that was a small risk; for a brain-dump
// journal containing business strategy, money, and personal life it is not.
//
// So these routes support a shared secret. It is enforced WHEN SET, which means:
//   - Set ACTIONABLE_API_KEY → every request must present it. Recommended, and
//     the setup guide says so.
//   - Leave it unset → routes stay open, matching how the rest of this app
//     already behaves, and NOTHING that exists today breaks.
//
// This is a deliberate trade: fail-open preserves the "add alongside, break
// nothing" constraint, and the guide's step 6 turns it on. It is not a claim
// that the endpoints are secure by default — they are not until that value is set.
// ---------------------------------------------------------------------------

import { timingSafeEqual } from 'node:crypto';

export function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ACTIONABLE_ALLOW_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Actionable-Key');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

export function requireAuth(req, res) {
  const expected = process.env.ACTIONABLE_API_KEY;
  if (!expected) return true; // not configured — see the note above

  const got = req.headers['x-actionable-key'];
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(expected);
  // timingSafeEqual throws when lengths differ, so compare length first.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Unauthorized — missing or wrong X-Actionable-Key header' });
    return false;
  }
  return true;
}

export function readQuery(req, key, fallback = null) {
  const v = req.query?.[key];
  if (Array.isArray(v)) return v[0] ?? fallback;
  return (v === undefined || v === '') ? fallback : v;
}
