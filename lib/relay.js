// lib/relay.js — Helmian Connect relay tenancy for the ThinkinBuddy
// store build: tenant-scoped channels, computer pairing (one-time
// 6-digit codes -> per-device tokens), and the Connect entitlement
// gate. Schema: sql/store/005_relay.sql. Product contract:
// docs/store/HELMIAN_CONNECT.md.
//
// ─── What this replaces ──────────────────────────────────────────────
// The relay (sql/relay.sql, server/handlers/relay-http.js +
// relay-proxy.js) predates the store build and is wired personally:
// ONE channel ('pilot', via HELMION_RELAY_CHANNEL), ONE shared secret
// (HELMION_RELAY_SECRET), and relay-http prefers Troy's personal vault
// database (NEON_CLAUDE_MEMORY_URL). That wiring is COMPAT MODE and it
// is untouched by this file: with SESSION_SECRET unset every relay
// path behaves exactly as it always has.
//
// In HOSTED mode (SESSION_SECRET set) identity comes from the caller,
// never from shared configuration:
//   - a tenant session token (lib/tenant.js) maps to that tenant's
//     derived channel;
//   - a paired computer's device token maps to ITS tenant's channel.
// The 'pilot' channel and the personal secret authenticate nothing in
// hosted mode.
//
// ─── Secrets handling ────────────────────────────────────────────────
// - Pairing codes: 6 digits, 10-minute life, single-use. Only the
//   SHA-256 hash is stored. (A fast hash is the right shape here: the
//   code is high-entropy-per-attempt only with rate limiting, and its
//   real protections are the 10-minute expiry, single use, and that
//   minting a fresh code kills the previous one. The stored value is
//   still never the code itself.)
// - Device tokens: 32 random bytes, hex. Only the SHA-256 hash is
//   stored. The raw token is returned EXACTLY ONCE — by
//   redeemPairingCode, to the computer redeeming the code — and never
//   appears in any list/read path afterwards.
//
// DB access mirrors lib/profile.js / lib/usage.js: DB functions take a
// pg Pool/client (or an async factory returning one) as the first
// argument so tests pass a fake. getRelayDb() is the lazy shared-pool
// convenience for handlers and is never called by tests.
//
// ZERO new dependencies: node:crypto only.

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { getEntitlement } from './usage.js';
import { getProfileDb } from './profile.js';

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const CONNECT_PLAN = 'helmian_connect';
export const CONNECT_STATUSES = ['active', 'trialing'];

// ─── Channels ──────────────────────────────────────────────────────────

/**
 * The relay channel for one tenant: deterministic (the phone, the
 * server, and the paired computer all derive the same name from the
 * tenant id alone), unguessable (a truncated SHA-256 of the id — the
 * channel name travels in URLs and is not a credential, but there is
 * no reason to make it enumerable either), and shaped to satisfy
 * relay-http's channel rule (/^[a-z0-9][a-z0-9_-]{1,62}$/).
 * @param {string} tenantId  tenants.id (uuid)
 * @returns {string} e.g. 't-0123abcd4567ef89' (18 chars)
 */
export function channelForTenant(tenantId) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('channelForTenant: tenantId is required');
  }
  const digest = createHash('sha256').update(tenantId).digest('hex');
  return `t-${digest.slice(0, 16)}`;
}

// ─── Hashing ───────────────────────────────────────────────────────────

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/** SHA-256 of a 6-digit pairing code, as stored in relay_pairing_codes. */
export function hashPairingCode(code) {
  return sha256Hex(String(code).trim());
}

/** SHA-256 of a device token, as stored in relay_devices. */
export function hashDeviceToken(token) {
  return sha256Hex(String(token).trim());
}

// ─── DB plumbing (mirrors lib/profile.js) ──────────────────────────────

async function resolveDb(db) {
  return typeof db === 'function' ? await db() : db;
}

function rowsOf(result) {
  if (Array.isArray(result)) return result;
  return result?.rows || [];
}

function requirePool(pool, fn) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error(`${fn}: db (pg pool/client) required`);
  }
  return pool;
}

// ─── Entitlement gate ──────────────────────────────────────────────────

/**
 * The Helmian Connect gate: true ONLY when the tenant's entitlements
 * row (sql/store/001, kept true by the RevenueCat webhook) is the
 * helmian_connect plan in a live status ('active' or 'trialing').
 * Every other plan, a lapsed/cancelled Connect row, and a tenant with
 * no row at all are false — pairing and relay access fail closed.
 */
export async function requireConnectEntitlement(db, tenantId) {
  const pool = requirePool(await resolveDb(db), 'requireConnectEntitlement');
  if (!tenantId) return false;
  const row = await getEntitlement(pool, tenantId);
  return row?.plan === CONNECT_PLAN && CONNECT_STATUSES.includes(row?.status);
}

// ─── Pairing codes ─────────────────────────────────────────────────────

/**
 * Mint a pairing code for one tenant. Minting INVALIDATES the tenant's
 * previous unused codes first, so at most one live code exists per
 * tenant at any moment — a parent who taps "Connect a computer" twice
 * never leaves a stale code lying around.
 * @returns {Promise<{ code: string, expiresAt: string }>} the raw code
 *   (shown to the parent once, in the app) and its ISO expiry.
 */
export async function createPairingCode(db, tenantId, now = new Date()) {
  const pool = requirePool(await resolveDb(db), 'createPairingCode');
  if (!tenantId) throw new Error('createPairingCode: tenantId required');
  const at = now instanceof Date ? now : new Date(now);
  const expiresAt = new Date(at.getTime() + PAIRING_CODE_TTL_MS);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await pool.query(
    `UPDATE relay_pairing_codes SET used_at = $2
      WHERE tenant_id = $1 AND used_at IS NULL`,
    [tenantId, at.toISOString()],
  );
  await pool.query(
    `INSERT INTO relay_pairing_codes (id, tenant_id, code_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), tenantId, hashPairingCode(code), expiresAt.toISOString()],
  );
  return { code, expiresAt: expiresAt.toISOString() };
}

/**
 * Redeem a pairing code from a computer: the code is consumed
 * (single-use — a second redeem of the same code fails), a device row
 * is created, and the device's credential is minted.
 * @returns {Promise<{ tenantId: string, deviceId: string,
 *   deviceToken: string } | null>} null for an unknown, expired,
 *   already-used, or ambiguous code. The raw deviceToken exists ONLY
 *   in this return value — it is never stored and never returned again.
 */
export async function redeemPairingCode(db, code, deviceLabel, now = new Date()) {
  const pool = requirePool(await resolveDb(db), 'redeemPairingCode');
  if (typeof code !== 'string' || !code.trim()) return null;
  const at = now instanceof Date ? now : new Date(now);
  const result = await pool.query(
    `SELECT id, tenant_id FROM relay_pairing_codes
      WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2`,
    [hashPairingCode(code), at.toISOString()],
  );
  const rows = rowsOf(result);
  // Fail closed on ambiguity: two tenants holding the same live 6-digit
  // code at once is rare but possible, and guessing would pair this
  // computer to a stranger. The parent just mints a fresh code.
  if (rows.length !== 1) return null;
  const { id, tenant_id: tenantId } = rows[0];
  const consumed = await pool.query(
    `UPDATE relay_pairing_codes SET used_at = $2
      WHERE id = $1 AND used_at IS NULL`,
    [id, at.toISOString()],
  );
  if (consumed && typeof consumed.rowCount === 'number' && consumed.rowCount === 0) {
    return null; // lost a race with a parallel redeem of the same code
  }
  const deviceId = randomUUID();
  const deviceToken = randomBytes(32).toString('hex');
  const label = typeof deviceLabel === 'string' && deviceLabel.trim()
    ? deviceLabel.trim().slice(0, 120)
    : null;
  await pool.query(
    `INSERT INTO relay_devices (id, tenant_id, device_label, device_token_hash)
     VALUES ($1, $2, $3, $4)`,
    [deviceId, tenantId, label, hashDeviceToken(deviceToken)],
  );
  return { tenantId, deviceId, deviceToken };
}

// ─── Devices ───────────────────────────────────────────────────────────

/**
 * Resolve a device token to its device row (no token material — the
 * row never carries any), or null for an unknown or REVOKED token.
 */
export async function authenticateDeviceRecord(db, deviceToken) {
  const pool = requirePool(await resolveDb(db), 'authenticateDeviceRecord');
  if (typeof deviceToken !== 'string' || !deviceToken.trim()) return null;
  const result = await pool.query(
    `SELECT id, tenant_id, device_label FROM relay_devices
      WHERE device_token_hash = $1 AND revoked_at IS NULL`,
    [hashDeviceToken(deviceToken)],
  );
  const row = rowsOf(result)[0];
  if (!row) return null;
  return { tenantId: row.tenant_id, deviceId: row.id, deviceLabel: row.device_label ?? null };
}

/**
 * Resolve a device token to the tenant it speaks for, or null.
 * @returns {Promise<string | null>} tenants.id
 */
export async function authenticateDevice(db, deviceToken) {
  const record = await authenticateDeviceRecord(db, deviceToken);
  return record?.tenantId ?? null;
}

/** Stamp a device as seen now (presence for the parent's device list). */
export async function recordDeviceSeen(db, deviceId, now = new Date()) {
  const pool = requirePool(await resolveDb(db), 'recordDeviceSeen');
  if (!deviceId) return false;
  const at = now instanceof Date ? now : new Date(now);
  const result = await pool.query(
    `UPDATE relay_devices SET last_seen_at = $2 WHERE id = $1`,
    [deviceId, at.toISOString()],
  );
  return !result || typeof result.rowCount !== 'number' || result.rowCount > 0;
}

/**
 * The tenant's devices for the Account & Safety list: labels and
 * timestamps ONLY — token hashes never leave the server.
 */
export async function listDevices(db, tenantId) {
  const pool = requirePool(await resolveDb(db), 'listDevices');
  if (!tenantId) return [];
  const result = await pool.query(
    `SELECT id, device_label, paired_at, last_seen_at, revoked_at
       FROM relay_devices WHERE tenant_id = $1 ORDER BY paired_at DESC`,
    [tenantId],
  );
  return rowsOf(result).map((r) => ({
    id: r.id,
    device_label: r.device_label ?? null,
    paired_at: r.paired_at ?? null,
    last_seen_at: r.last_seen_at ?? null,
    revoked_at: r.revoked_at ?? null,
  }));
}

/**
 * Revoke one of the tenant's OWN devices (the tenant filter is part of
 * the UPDATE — a tenant can never revoke another tenant's computer).
 * @returns {Promise<boolean>} true when a live device row was revoked.
 */
export async function revokeDevice(db, tenantId, deviceId, now = new Date()) {
  const pool = requirePool(await resolveDb(db), 'revokeDevice');
  if (!tenantId || !deviceId) return false;
  const at = now instanceof Date ? now : new Date(now);
  const result = await pool.query(
    `UPDATE relay_devices SET revoked_at = $3
      WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
    [deviceId, tenantId, at.toISOString()],
  );
  return Boolean(result && typeof result.rowCount === 'number' && result.rowCount > 0);
}

let _pool = null;

/**
 * Lazily build the shared pg pool for relay pairing/entitlement reads.
 * The pairing tables live with the rest of the store schema (001's
 * header: one shared database), so this delegates to lib/profile.js's
 * factory (which delegates to lib/usage.js's). Handlers pass this
 * function itself into the DB functions, so the pool is only built when
 * a hosted-mode relay call actually happens — never in compat mode,
 * never in tests.
 */
export async function getRelayDb() {
  if (_pool) return _pool;
  _pool = await getProfileDb();
  return _pool;
}
