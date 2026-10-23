// lib/profile.js — tenant profiles for the ThinkinBuddy store build
// (accounts bite). The profile (sql/store/001: display_name, age_band,
// about_me, safety_mode, parent_pin_hash) is the ONLY "config" a user
// ever fills in, and as of this bite it is also the SAFETY AUTHORITY:
// the paid handlers (chat, speak, image, video) feed profileSafety()
// from the tenant's profile row in hosted mode, replacing the
// request-supplied safety inputs the safety bite had to settle for.
// Troy's PIN rule lives here too: once a parent PIN is set, turning
// safety_mode OFF requires that PIN (enforced in server/handlers/
// profile.js, using verifyParentPin below).
//
// AGE_BANDS aligns with lib/safety.js isMinorAgeBand semantics: 'child',
// '6-8' and '9-12' are minor bands (fail-closed moderation + kid safety
// core); '13-17' starts at 13 and 'adult' is adult — neither is minor
// under the documented COPPA under-13 rule. Keep the two files'
// semantics in lockstep: a band added here must mean the same thing in
// isMinorAgeBand.
//
// DB access mirrors lib/usage.js: DB functions take a pg Pool/client
// (or an async factory returning one) as the first argument so tests
// pass a fake. getProfileDb() is the lazy shared-pool convenience for
// handlers and is never called by tests.

import { hashPin, verifyPin, safetyDecision } from './safety.js';
import { getUsageDb } from './usage.js';

/** The age bands onboarding offers, narrowest first. */
export const AGE_BANDS = ['child', '6-8', '9-12', '13-17', 'adult'];

/** The only profile fields a client may write via upsertProfile. */
export const PROFILE_FIELDS = ['display_name', 'age_band', 'about_me', 'safety_mode'];

async function resolveDb(db) {
  return typeof db === 'function' ? await db() : db;
}

function rowsOf(result) {
  if (Array.isArray(result)) return result;
  return result?.rows || [];
}

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * The tenant's profile row (all columns, including parent_pin_hash —
 * callers that SERIALIZE a profile must whitelist fields, see
 * server/handlers/profile.js), or null when the tenant has none.
 */
export async function getProfile(db, tenantId) {
  const pool = await resolveDb(db);
  if (!pool || typeof pool.query !== 'function') throw new Error('getProfile: db (pg pool/client) required');
  if (!tenantId) return null;
  const result = await pool.query(
    `SELECT tenant_id, display_name, age_band, about_me, safety_mode,
            parent_pin_hash, created_at, updated_at
       FROM profiles WHERE tenant_id = $1`,
    [tenantId],
  );
  return rowsOf(result)[0] || null;
}

/**
 * Create-or-update the tenant's profile from the whitelisted fields in
 * PROFILE_FIELDS only — anything else in `fields` (parent_pin_hash,
 * password_hash, tenant_id, …) is IGNORED, so a client can never write
 * credential material through the profile path. The PIN changes only
 * via setParentPin. age_band, when present, must be one of AGE_BANDS.
 * @returns {Promise<object>} the profile row after the write
 * @throws Error with .code 'invalid_age_band' | 'invalid_field'
 */
export async function upsertProfile(db, tenantId, fields = {}) {
  const pool = await resolveDb(db);
  if (!pool || typeof pool.query !== 'function') throw new Error('upsertProfile: db (pg pool/client) required');
  if (!tenantId) throw new Error('upsertProfile: tenantId required');
  const clean = {};
  for (const field of PROFILE_FIELDS) {
    if (fields[field] === undefined) continue;
    const value = fields[field];
    if (field === 'age_band' && value !== null && !AGE_BANDS.includes(value)) {
      throw codedError('invalid_age_band', `age_band must be one of: ${AGE_BANDS.join(', ')}`);
    }
    if (field === 'safety_mode' && value !== null && typeof value !== 'boolean') {
      throw codedError('invalid_field', 'safety_mode must be a boolean');
    }
    if ((field === 'display_name' || field === 'about_me') && value !== null && typeof value !== 'string') {
      throw codedError('invalid_field', `${field} must be a string`);
    }
    clean[field] = value;
  }
  if (Object.keys(clean).length === 0) return getProfile(pool, tenantId);
  const cols = Object.keys(clean);
  const placeholders = cols.map((_, i) => `$${i + 2}`);
  const updates = cols.map((c) => `${c} = EXCLUDED.${c}`);
  const result = await pool.query(
    `INSERT INTO profiles (tenant_id, ${cols.join(', ')})
     VALUES ($1, ${placeholders.join(', ')})
     ON CONFLICT (tenant_id) DO UPDATE SET ${updates.join(', ')}, updated_at = now()
     RETURNING tenant_id, display_name, age_band, about_me, safety_mode,
               parent_pin_hash, created_at, updated_at`,
    [tenantId, ...cols.map((c) => clean[c])],
  );
  return rowsOf(result)[0] || getProfile(pool, tenantId);
}

/**
 * Set (or replace) the tenant's parent PIN. Stored only as a
 * lib/safety.js scrypt hash in profiles.parent_pin_hash. PIN policy:
 * a string of 4–12 characters (it is a PIN a parent types on a phone,
 * not a password — the account password in lib/accounts.js carries the
 * real length floor).
 * @throws Error with .code 'invalid_pin'
 */
export async function setParentPin(db, tenantId, pin) {
  const pool = await resolveDb(db);
  if (!pool || typeof pool.query !== 'function') throw new Error('setParentPin: db (pg pool/client) required');
  if (!tenantId) throw new Error('setParentPin: tenantId required');
  if (typeof pin !== 'string' || pin.length < 4 || pin.length > 12) {
    throw codedError('invalid_pin', 'pin must be a string of 4-12 characters');
  }
  await pool.query(
    `INSERT INTO profiles (tenant_id, parent_pin_hash) VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE
       SET parent_pin_hash = EXCLUDED.parent_pin_hash, updated_at = now()`,
    [tenantId, hashPin(pin)],
  );
  return true;
}

/**
 * Check a PIN against the tenant's stored parent PIN.
 * @returns {Promise<boolean>} false when no PIN is set, the tenant has
 *   no profile, or the PIN is wrong.
 */
export async function verifyParentPin(db, tenantId, pin) {
  const profile = await getProfile(db, tenantId);
  if (!profile?.parent_pin_hash) return false;
  return verifyPin(pin, profile.parent_pin_hash);
}

/**
 * The safety decision for one tenant profile — THE helper the paid
 * handlers call in hosted mode, so what the tests pin here is the
 * production behavior, not a test-only copy. A null profile yields the
 * neutral decision (no fail-closed, no kid core): profiles are created
 * empty at signup, and a tenant who never finished onboarding gets the
 * standard posture until they pick an age band / safety mode.
 * @param {object|null} profile  a profiles row (or null)
 * @returns {{ failClosed: boolean, kidCore: boolean }}
 */
export function profileSafety(profile) {
  if (!profile) return safetyDecision({});
  return safetyDecision({
    safetyMode: profile.safety_mode === true,
    ageBand: profile.age_band ?? null,
  });
}

let _pool = null;

/**
 * Lazily build the shared pg pool for profile reads/writes. Profiles
 * live in the same database as everything else (001's header), so this
 * delegates to lib/usage.js's pool factory. Handlers pass this function
 * itself into getProfile (the factory form), so the pool is only built
 * when a profile is actually read — never in compat mode, never in
 * tests.
 */
export async function getProfileDb() {
  if (_pool) return _pool;
  _pool = await getUsageDb();
  return _pool;
}
