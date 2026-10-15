// lib/actionable/google-auth.js
// ---------------------------------------------------------------------------
// One-click "Connect Google Docs" — OAuth 2.0 authorization-code flow.
//
// WHY OAUTH AND NOT A WEBHOOK: the existing app asks the user to deploy a Google
// Apps Script, set it to "Anyone", copy an /exec URL, and paste it into an env
// var (BLUEPRINT_VOICE.md:57-91). That is a fine developer workflow and a
// terrible consumer one — most people have never heard of a webhook, and the
// "Who has access: Anyone" step is a security decision handed to someone with no
// way to evaluate it. The webhook path is KEPT, in Advanced settings, because it
// works and Troy's existing customers already run it.
//
// 🛑 NOTHING HERE CREATES A GOOGLE CLOUD PROJECT OR AN OAUTH CLIENT. Every value
// is read from env and is a PLACEHOLDER until Troy fills it in. The numbered
// setup list is docs/ACTIONABLE_SETUP.md.
//
// TOKENS ARE SERVER-SIDE ONLY. The refresh token is stored in Postgres and never
// leaves the backend; the phone receives a connected/disconnected boolean and an
// email address, nothing more. A refresh token in an app bundle or in
// AsyncStorage is a permanent, unrevokable grant sitting on a device.
// ---------------------------------------------------------------------------

import { getPool } from '../../server/handlers/memory.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// ---------------------------------------------------------------------------
// SCOPES — deliberately NON-SENSITIVE ONLY. This choice is worth weeks and money.
//
// Google classifies scopes as non-sensitive / sensitive / restricted, and the
// class decides what it costs to ship:
//   restricted (`drive`, `drive.readonly`, …) → ~6 WEEKS review, plus an ANNUAL
//     third-party CASA security assessment the developer pays for. And because
//     this app transmits through a server, storing/transmitting restricted-scope
//     data triggers that assessment automatically.
//   sensitive (`documents`, `spreadsheets`)   → ~10 business days review, a
//     demo video, a privacy policy on the verified domain.
//   non-sensitive (`drive.file`)              → "basic OAuth App Verification".
//
// `drive.file` alone is enough for EVERYTHING this app does, verified against
// the method references rather than assumed:
//   documents.create      accepts drive.file
//   documents.batchUpdate accepts drive.file  ("Requires one of the following
//     OAuth scopes: …/documents, …/drive, …/drive.file")
//   spreadsheets.values.append accepts drive.file (same three-scope list)
//   drive files.create / files.update — drive.file is its home scope
//
// So `documents` and `spreadsheets` are NOT requested. Asking for them would buy
// nothing except a sensitive-scope review.
//
// The one real constraint drive.file imposes: this app can only touch files IT
// created. It cannot open a document the user made by hand. That is exactly the
// right shape here — Actionable creates its own entry documents and its own
// spreadsheet — and it is also the honest thing to show on a consent screen.
//
// userinfo.email is non-sensitive and is here so Settings can show WHICH account
// is connected; connecting a work login instead of a personal one and not
// knowing is a real support problem.
export const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
];

export function googleConfig() {
  return {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || '',
  };
}

export function isGoogleConfigured() {
  const c = googleConfig();
  return Boolean(c.clientId && c.clientSecret && c.redirectUri);
}

// state carries the user id and a nonce. Signed with an HMAC so the callback
// cannot be driven with a forged state to bind a stranger's Google account to
// somebody else's Actionable user id.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function stateSecret() {
  const s = process.env.ACTIONABLE_STATE_SECRET || '';
  if (!s) throw new Error('ACTIONABLE_STATE_SECRET not set — required to sign the OAuth state parameter');
  return s;
}

// The state carries BOTH the user and the provider, so one signed value drives
// every service's callback and a forged state cannot bind a stranger's account
// to somebody else's journal — or redirect one provider's code into another
// provider's token exchange.
export function makeState(userId, provider = 'google-docs') {
  const payload = JSON.stringify({
    u: userId, p: provider, n: randomBytes(9).toString('base64url'), t: Date.now(),
  });
  const b = Buffer.from(payload).toString('base64url');
  const sig = createHmac('sha256', stateSecret()).update(b).digest('base64url');
  return `${b}.${sig}`;
}

// Returns the full payload. readState() is kept below returning just the user id,
// because api/actionable-google-callback.js already depends on that shape.
export function readStateFull(state, maxAgeMs = 10 * 60 * 1000) {
  const [b, sig] = String(state || '').split('.');
  if (!b || !sig) throw new Error('Malformed OAuth state');

  const expected = createHmac('sha256', stateSecret()).update(b).digest('base64url');
  const a = Buffer.from(sig);
  const e = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (a.length !== e.length || !timingSafeEqual(a, e)) throw new Error('OAuth state signature mismatch');

  const payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
  if (!payload.u) throw new Error('OAuth state carried no user');
  if (Date.now() - Number(payload.t || 0) > maxAgeMs) throw new Error('OAuth state expired — start the connection again');
  return { userId: payload.u, provider: payload.p || 'google-docs' };
}

export function readState(state, maxAgeMs = 10 * 60 * 1000) {
  return readStateFull(state, maxAgeMs).userId;
}

export function buildAuthUrl(userId) {
  const { clientId, redirectUri } = googleConfig();
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    // offline + consent is what actually returns a refresh_token. Without
    // prompt=consent Google omits it on every grant after the first, and the
    // connection silently stops working an hour later when the access token
    // expires with nothing to refresh from.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: makeState(userId),
  });
  return `${AUTH_URL}?${p.toString()}`;
}

async function tokenRequest(body) {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Google token error ${resp.status}: ${json.error_description || json.error || 'unknown'}`);
  }
  return json;
}

export async function exchangeCode(code) {
  const { clientId, clientSecret, redirectUri } = googleConfig();
  return tokenRequest({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
}

export async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = googleConfig();
  return tokenRequest({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });
}

export async function saveGoogleAccount(userId, tokens) {
  const pool = getPool();
  let email = null;
  try {
    const r = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (r.ok) email = (await r.json()).email || null;
  } catch { /* email is a nicety, not a requirement */ }

  const expiresAt = new Date(Date.now() + (Number(tokens.expires_in || 3600) - 60) * 1000);

  await pool.query(
    `INSERT INTO actionable_google_accounts
       (user_id, refresh_token, access_token, expires_at, email, scopes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id) DO UPDATE SET
       -- Google only returns a refresh_token on the FIRST consent. COALESCE keeps
       -- the stored one when a re-auth omits it; overwriting with NULL would
       -- break the connection an hour later, which is exactly the bug that makes
       -- OAuth integrations "randomly stop working".
       refresh_token = COALESCE(EXCLUDED.refresh_token, actionable_google_accounts.refresh_token),
       access_token  = EXCLUDED.access_token,
       expires_at    = EXCLUDED.expires_at,
       email         = COALESCE(EXCLUDED.email, actionable_google_accounts.email),
       scopes        = EXCLUDED.scopes,
       updated_at    = now()`,
    [userId, tokens.refresh_token || null, tokens.access_token, expiresAt, email, tokens.scope || SCOPES.join(' ')]
  );

  return { email, scopes: tokens.scope || SCOPES.join(' ') };
}

// Returns a live access token, refreshing when needed. null when not connected.
export async function getAccessToken(userId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT refresh_token, access_token, expires_at FROM actionable_google_accounts WHERE user_id = $1`,
    [userId]
  );
  if (!rows.length) return null;

  const row = rows[0];
  if (row.access_token && row.expires_at && new Date(row.expires_at) > new Date()) {
    return row.access_token;
  }
  if (!row.refresh_token) return null;

  const fresh = await refreshAccessToken(row.refresh_token);
  const expiresAt = new Date(Date.now() + (Number(fresh.expires_in || 3600) - 60) * 1000);
  await pool.query(
    `UPDATE actionable_google_accounts SET access_token = $2, expires_at = $3, updated_at = now() WHERE user_id = $1`,
    [userId, fresh.access_token, expiresAt]
  );
  return fresh.access_token;
}

export async function googleStatus(userId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT email, scopes, created_at FROM actionable_google_accounts WHERE user_id = $1`,
    [userId]
  );
  if (!rows.length) return { connected: false, email: null };
  return { connected: true, email: rows[0].email, scopes: rows[0].scopes, connectedAt: rows[0].created_at };
}

export async function disconnectGoogle(userId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT refresh_token FROM actionable_google_accounts WHERE user_id = $1`, [userId]
  );
  // Revoke at Google as well as deleting locally. Deleting only our row leaves a
  // live grant on his Google account that he believes he disconnected.
  if (rows[0]?.refresh_token) {
    try {
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: rows[0].refresh_token }).toString(),
      });
    } catch (e) {
      console.error('[actionable] Google revoke failed (local record still removed):', e?.message || e);
    }
  }
  await pool.query(`DELETE FROM actionable_google_accounts WHERE user_id = $1`, [userId]);
  return { ok: true };
}
