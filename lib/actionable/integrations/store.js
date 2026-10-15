// lib/actionable/integrations/store.js
// ---------------------------------------------------------------------------
// Persistence for connections, uniform across every provider kind.
//
// Google keeps its own pre-existing table (actionable_google_accounts) because
// that code was written and proven first; every other provider lives in
// actionable_connections. The provider interface hides the difference, so
// callers never branch on it.
//
// 🔴 THE REFRESH LOCK IS NOT OPTIONAL. Todoist rotates its refresh token on
// every use and REVOKES ALL TOKENS if an old one is replayed outside a ~60s
// grace window — a permanent logout, not a retryable error. Two concurrent
// pushes both noticing an expired token is a completely ordinary race, and
// without serialization it silently destroys the connection. Postgres advisory
// locks give us that serialization across serverless instances, where an
// in-process mutex would be worthless because each instance has its own.
// ---------------------------------------------------------------------------

import { getPool } from '../../../server/handlers/memory.js';
import { getProvider } from './registry.js';

export async function listConnections(userId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT provider, account_label, target_url, config, created_at, updated_at
       FROM actionable_connections
      WHERE user_id = $1
      ORDER BY created_at`,
    [userId]
  );
  return rows.map(r => ({
    provider: r.provider,
    accountLabel: r.account_label,
    // NEVER return the token. The URL is masked because for Zapier/Make the URL
    // IS the credential — showing it in full lets a shoulder-surfer take it.
    targetUrl: r.target_url ? maskUrl(r.target_url) : null,
    config: stripSecrets(r.config),
    connectedAt: r.created_at,
  }));
}

function maskUrl(u) {
  try {
    const url = new URL(u);
    const tail = url.pathname.slice(-6);
    return `${url.origin}/…${tail}`;
  } catch { return '…'; }
}

function stripSecrets(config) {
  if (!config || typeof config !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    if (/token|secret|key|password/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export async function saveConnection(userId, providerId, tokens) {
  const pool = getPool();
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + (Number(tokens.expires_in) - 60) * 1000)
    : null;

  await pool.query(
    `INSERT INTO actionable_connections
       (user_id, provider, access_token, refresh_token, expires_at, account_label, target_url, config)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       access_token  = EXCLUDED.access_token,
       -- Same reasoning as the Google table: a re-auth that omits the refresh
       -- token must not blank the stored one, or the connection dies quietly an
       -- hour later.
       refresh_token = COALESCE(EXCLUDED.refresh_token, actionable_connections.refresh_token),
       expires_at    = EXCLUDED.expires_at,
       account_label = COALESCE(EXCLUDED.account_label, actionable_connections.account_label),
       target_url    = COALESCE(EXCLUDED.target_url, actionable_connections.target_url),
       config        = COALESCE(EXCLUDED.config, actionable_connections.config),
       updated_at    = now()`,
    [
      userId, providerId,
      tokens.access_token || null,
      tokens.refresh_token || null,
      expiresAt,
      tokens.account_label || null,
      tokens.target_url || null,
      JSON.stringify(tokens.config || {}),
    ]
  );
  return { ok: true };
}

export async function saveUrlConnection(userId, providerId, url) {
  return saveConnection(userId, providerId, {
    target_url: url,
    account_label: hostOf(url),
    config: {},
  });
}

function hostOf(u) {
  try { return new URL(u).host; } catch { return 'custom URL'; }
}

export async function deleteConnection(userId, providerId) {
  const pool = getPool();
  const r = await pool.query(
    `DELETE FROM actionable_connections WHERE user_id = $1 AND provider = $2`,
    [userId, providerId]
  );
  return { deleted: r.rowCount };
}

// A stable 64-bit key for the advisory lock, derived from user + provider so two
// different users never block each other.
function lockKey(userId, providerId) {
  const s = `${userId}:${providerId}`;
  let h = 0n;
  for (const ch of s) h = (h * 131n + BigInt(ch.charCodeAt(0))) % 9223372036854775807n;
  return h;
}

// Returns { accessToken, targetUrl, config } ready to push with, refreshing the
// token first if needed — under a lock, for the reason at the top of this file.
export async function getUsableConnection(userId, providerId) {
  const pool = getPool();
  const provider = getProvider(providerId);
  if (!provider) return null;

  const { rows } = await pool.query(
    `SELECT access_token, refresh_token, expires_at, target_url, config
       FROM actionable_connections WHERE user_id = $1 AND provider = $2`,
    [userId, providerId]
  );
  if (!rows.length) return null;
  const row = rows[0];

  if (provider.kind === 'url' || provider.kind === 'script') {
    return { accessToken: '', targetUrl: row.target_url, config: row.config || {} };
  }

  const stillValid = row.access_token && (!row.expires_at || new Date(row.expires_at) > new Date());
  if (stillValid) {
    return { accessToken: row.access_token, targetUrl: null, config: row.config || {} };
  }
  if (!row.refresh_token || typeof provider.refresh !== 'function') {
    return { accessToken: row.access_token, targetUrl: null, config: row.config || {} };
  }

  const client = await pool.connect();
  try {
    // Blocking lock, not try-lock: the loser should WAIT and then re-read the
    // token the winner just wrote, not give up and push with a dead one.
    await client.query('SELECT pg_advisory_lock($1)', [lockKey(userId, providerId).toString()]);

    // Re-read inside the lock — the other request may have refreshed already,
    // and replaying the now-rotated token is precisely what revokes everything.
    const { rows: fresh } = await client.query(
      `SELECT access_token, refresh_token, expires_at, config
         FROM actionable_connections WHERE user_id = $1 AND provider = $2`,
      [userId, providerId]
    );
    const cur = fresh[0];
    if (cur?.access_token && cur.expires_at && new Date(cur.expires_at) > new Date()) {
      return { accessToken: cur.access_token, targetUrl: null, config: cur.config || {} };
    }

    const t = await provider.refresh(cur.refresh_token);
    const expiresAt = t.expires_in
      ? new Date(Date.now() + (Number(t.expires_in) - 60) * 1000)
      : null;
    await client.query(
      `UPDATE actionable_connections
          SET access_token = $3, refresh_token = COALESCE($4, refresh_token),
              expires_at = $5, updated_at = now()
        WHERE user_id = $1 AND provider = $2`,
      [userId, providerId, t.access_token, t.refresh_token || null, expiresAt]
    );
    return { accessToken: t.access_token, targetUrl: null, config: cur.config || {} };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [lockKey(userId, providerId).toString()])
      .catch(() => {});
    client.release();
  }
}
