// lib/usage.js — usage metering for the ThinkinBuddy hosted model
// (store bite: metering + master-key proxy). See
// docs/store/PROVIDER_TEST_CONNECTIONS.md and the store plan's money
// model: WE host it — one subscription, a monthly credit bucket, video
// and extras as credit packs, bring-your-own-key (BYO) optional.
//
// ─── Credits ─────────────────────────────────────────────────────────────
// 1 credit = $0.001 (a tenth of a cent) of provider cost — the planning
// unit, NOT a price we charge. cost_micros in usage_ledger is credits ×
// 1000 (millionths of a dollar), matching sql/store/001_tenants.sql.
//
// The rates in CREDIT_COSTS are set from the Bite 0 audit's real
// provider prices (Oct 2026, audit §4):
//   - Video dominates everything: Runway Gen-4 Turbo is 5 credits/s on
//     Runway's own credit scale = $0.05/s, Gen-4.5 = $0.12/s. We meter
//     60 credits ($0.06) per second — above the Turbo path's real cost
//     (pricing-report fix; the original 10 credits/s metered at a
//     fifth of real cost, so the bucket did not cap real dollars).
//     Gen-4.5 is NOT covered at this rate, so bucket-paid (metered)
//     requests are forced to gen4_turbo in video-runway.js. The
//     30-credit floor stays, so a "free" 1-second clip can never dodge
//     the per-job overheads (start-frame image, polling, rehosting).
//   - Images: FLUX schnell on Replicate is $0.003/image (dev $0.025);
//     gpt-image-2 is per-image in the same cents range. 5 credits
//     ($0.005) covers the default paths.
//   - TTS: ElevenLabs bills per character (~$0.04 per 1,000 chars for
//     Flash/Turbo TTS; a live voice conversation runs ~$0.08/min
//     all-in). We meter 20 credits per 100 chars ($0.20 per 1,000
//     chars) — above real cost with headroom (pricing-report fix; the
//     original 1 credit per 100 chars metered at a fraction of it).
//   - Chat: a Haiku/Flash-Lite-class reply with capped output
//     (max_tokens 400 in chat.js) costs well under $0.001; 1 credit per
//     message is the simple, honest unit.
//   - Embeddings / memory ops: text-embedding-3-small is $0.02 per
//     MILLION tokens — a memory embed is a rounding error, and charging
//     for remembering would punish exactly the behavior the product
//     sells. Metered at 0 and documented here rather than silently
//     skipped.
//
// ─── When metering applies — shouldMeter() ──────────────────────────────
// Two conditions, mirroring tenant enforcement (lib/tenant.js):
//   1. ENFORCED mode only: SESSION_SECRET set = the hosted deployment.
//      Compat mode (no SESSION_SECRET — Troy's live single-user app)
//      meters NOTHING: handlers make no metering calls at all and
//      behave exactly as before this bite.
//   2. NEVER for BYO keys: when lib/userKeys.js resolveKey reports
//      source 'user' for the provider's key, the user is paying that
//      provider directly on their own account. Charging their
//      subscription bucket for it too would be double-billing — so both
//      the bucket check AND the ledger write are skipped. If the same
//      request falls back to our server env key (source 'env'), it
//      meters normally: our key, our bill, their bucket.
//
// ─── Failure posture ────────────────────────────────────────────────────
// checkBucket failing (DB down) fails CLOSED in meterGate: an enforced
// deployment that cannot see the ledger cannot prove the bucket has
// room, and video at $0.05–0.12/s is exactly the cost this exists to
// cap. recordUsage after a successful provider call is the opposite:
// the money is already spent, so a ledger write failure is logged
// loudly (safeRecordUsage) and never fails the user's response.
//
// DB access: every DB function takes a pg Pool/client as its first
// argument so tests can pass a fake — no hidden global pool in the
// tested paths. getUsageDb() is the one convenience accessor handlers
// use; it lazily builds the same pool shape as server/handlers/memory.js
// (DATABASE_URL_MEMORY || DATABASE_URL) and is never called in tests.

import { tenantEnforced } from './tenant.js';

export const CREDIT_USD = 0.001; // 1 credit = $0.001 of provider cost
export const MICROS_PER_CREDIT = 1000; // cost_micros = credits × 1000

export const CREDIT_COSTS = {
  chat: 1, // per chat message (reply)
  speak_per_100_chars: 20, // TTS: 20 credits per 100 chars, min 1 (costFor 'speak')
  image: 5, // per generated image
  video_per_second: 60, // per second of generated video (Turbo path; see header)
  video_min: 30, // floor per video job, however short
  embedding: 0, // $0.02/1M tokens — see header
  memory: 0, // memory reads/writes — the product's core, not a metered extra
};

/** Monthly credit grant per entitlements.plan (sql/store/001). */
export const PLAN_GRANTS = {
  free: 0,
  buddy: 10000,
  buddy_media: 25000,
  helmian_connect: 25000,
};

/**
 * Credits for one metered action.
 * @param {string} action  'chat' | 'speak' | 'image' | 'video' | 'embedding' | 'memory'
 * @param {object} [params] speak: { chars } or { text }; video: { seconds } or { duration }
 * @returns {number} credits (integer, >= 0)
 */
export function costFor(action, params = {}) {
  switch (action) {
    case 'chat':
    case 'chat_message':
      return CREDIT_COSTS.chat;
    case 'speak':
    case 'tts': {
      const chars = Number(params.chars ?? (typeof params.text === 'string' ? params.text.length : 0)) || 0;
      return Math.max(1, Math.ceil(chars / 100) * CREDIT_COSTS.speak_per_100_chars);
    }
    case 'image':
      return CREDIT_COSTS.image;
    case 'video': {
      const seconds = Number(params.seconds ?? params.duration ?? 0) || 0;
      const perSecond = Math.ceil(seconds) * CREDIT_COSTS.video_per_second;
      return Math.max(CREDIT_COSTS.video_min, perSecond);
    }
    case 'embedding':
      return CREDIT_COSTS.embedding;
    case 'memory':
      return CREDIT_COSTS.memory;
    default:
      throw new Error(`costFor: unknown action '${action}'`);
  }
}

/** 'YYYY-MM' (UTC) bucket period key for a date. */
export function monthKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthRange(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * Pure bucket math.
 * @param {{ granted: number, used: number }} input
 * @returns {{ granted: number, used: number, remaining: number, exhausted: boolean }}
 */
export function bucketState({ granted = 0, used = 0 } = {}) {
  const g = Math.max(0, Number(granted) || 0);
  const u = Math.max(0, Number(used) || 0);
  const remaining = Math.max(0, g - u);
  return { granted: g, used: u, remaining, exhausted: remaining <= 0 };
}

/**
 * Should this request be metered at all? The whole BYO/compat policy in
 * one pure function (handlers and tests share it):
 *   compat mode            -> false (no metering calls, behavior unchanged)
 *   enforced + user's key   -> false (they pay their own provider bill)
 *   enforced + server key   -> true
 * @param {{ enforced: boolean, keySource: 'user'|'env'|'none' }} input
 */
export function shouldMeter({ enforced = false, keySource = 'env' } = {}) {
  if (!enforced) return false;
  if (keySource === 'user') return false;
  return true;
}

function rowsOf(result) {
  if (Array.isArray(result)) return result;
  return result?.rows || [];
}

/**
 * Write one usage_ledger row. cost_micros = credits × 1000.
 * A duplicate request_id (retried call) is swallowed and returns false —
 * the partial unique index in sql/store/001 is what makes a retry safe
 * instead of a double charge.
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {{ tenantId: string, provider: string, action: string,
 *           units?: number, credits: number, requestId?: string }} usage
 * @returns {Promise<boolean>} true when the row was inserted
 */
export async function recordUsage(db, { tenantId, provider, action, units, credits, requestId } = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('recordUsage: db (pg pool/client) required');
  if (!tenantId) throw new Error('recordUsage: tenantId required');
  if (!action) throw new Error('recordUsage: action required');
  const costMicros = Math.round((Number(credits) || 0) * MICROS_PER_CREDIT);
  const unit = units != null ? `${action} x${units}` : action;
  try {
    await db.query(
      `INSERT INTO usage_ledger (tenant_id, provider, unit, cost_micros, request_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, provider || 'unknown', unit, costMicros, requestId || null],
    );
    return true;
  } catch (e) {
    // Unique violation (pg 23505) on request_id = this call was already
    // recorded by the first attempt. Not an error — just don't double up.
    if (e && (e.code === '23505' || /duplicate key|unique constraint/i.test(e.message || ''))) {
      return false;
    }
    throw e;
  }
}

/**
 * recordUsage that never throws: for the after-success write, where the
 * provider money is already spent and failing the user's response would
 * punish them for our bookkeeping problem. Logs loudly instead.
 * @returns {Promise<boolean>}
 */
export async function safeRecordUsage(db, usage) {
  try {
    return await recordUsage(db, usage);
  } catch (e) {
    console.error('[usage] recordUsage failed (provider call already succeeded):', e?.message || e);
    return false;
  }
}

/**
 * Total credits one tenant has used in the calendar month containing
 * `now` (UTC), from usage_ledger.
 * @returns {Promise<number>} credits
 */
export async function usageThisMonth(db, tenantId, now = new Date()) {
  if (!db || typeof db.query !== 'function') throw new Error('usageThisMonth: db (pg pool/client) required');
  const { start, end } = monthRange(now);
  const result = await db.query(
    `SELECT COALESCE(SUM(cost_micros), 0) AS micros
       FROM usage_ledger
      WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
    [tenantId, start.toISOString(), end.toISOString()],
  );
  const micros = Number(rowsOf(result)[0]?.micros ?? 0) || 0;
  return micros / MICROS_PER_CREDIT;
}

/**
 * The tenant's entitlements row (sql/store/001), or null when the tenant
 * has none — a tenant with no row is on no plan: grant 0.
 */
export async function getEntitlement(db, tenantId) {
  if (!db || typeof db.query !== 'function') throw new Error('getEntitlement: db (pg pool/client) required');
  const result = await db.query(
    `SELECT tenant_id, plan, status, current_period_end, revenuecat_app_user_id
       FROM entitlements WHERE tenant_id = $1`,
    [tenantId],
  );
  return rowsOf(result)[0] || null;
}

/**
 * Total unexpired credit-pack / promo grants for one tenant
 * (tenant_credit_grants, sql/store/003 — written by the RevenueCat
 * webhook, lib/billing.js). Grants sit ON TOP of the monthly plan
 * bucket and do not reset with the month; a grant whose expires_at has
 * passed no longer counts. NULL expires_at = never expires.
 *
 * If the 003 migration has not run yet (pg 42P01, undefined table) the
 * tenant simply has no grants — plan-only buckets keep working while
 * billing is being rolled out.
 * @returns {Promise<number>} credits
 */
export async function creditGrantsTotal(db, tenantId, now = new Date()) {
  if (!db || typeof db.query !== 'function') throw new Error('creditGrantsTotal: db (pg pool/client) required');
  let result;
  try {
    result = await db.query(
      `SELECT COALESCE(SUM(credits), 0) AS credits
         FROM tenant_credit_grants
        WHERE tenant_id = $1 AND (expires_at IS NULL OR expires_at > $2)`,
      [tenantId, (now instanceof Date ? now : new Date(now)).toISOString()],
    );
  } catch (e) {
    if (e && e.code === '42P01') {
      console.error('[usage] tenant_credit_grants missing (sql/store/003 not run yet) — treating grants as 0');
      return 0;
    }
    throw e;
  }
  return Number(rowsOf(result)[0]?.credits ?? 0) || 0;
}

/**
 * Bucket state for one tenant: PLAN_GRANTS for their plan, PLUS any
 * unexpired credit-pack grants (tenant_credit_grants, sql/store/003),
 * minus this month's usage.
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {string} tenantId
 * @param {object|string|null} [planRow] entitlements row, a plan name, or
 *   null/undefined to look the row up.
 * @returns {Promise<{ plan: string|null, grants: number, granted: number,
 *   used: number, remaining: number, exhausted: boolean }>}
 */
export async function checkBucket(db, tenantId, planRow) {
  const row = planRow === undefined ? await getEntitlement(db, tenantId) : planRow;
  const plan = typeof row === 'string' ? row : row?.plan || null;
  const grants = await creditGrantsTotal(db, tenantId);
  const granted = (PLAN_GRANTS[plan] ?? 0) + grants;
  const used = await usageThisMonth(db, tenantId);
  return { plan, grants, ...bucketState({ granted, used }) };
}

/**
 * The pre-call gate the paid handlers use. Decides everything in one
 * place so each handler's metering block stays a few lines:
 *   - shouldMeter false (compat / BYO)  -> { meter:false, allowed:true }
 *     and NO database call is made at all.
 *   - enforced + server key: reads the entitlement + this month's usage;
 *     allowed only when the bucket covers the estimated cost. A bucket
 *     that cannot be read fails closed (see header).
 * @param {{ db: object|Function, tenantId: string, keySource: string,
 *           estCredits?: number }} input — db may be a pool/client or an
 *   async factory (handlers pass getUsageDb itself, so the pool is only
 *   built when metering actually applies — never in compat mode).
 */
export async function meterGate({ db, tenantId, keySource = 'env', estCredits = 0 } = {}) {
  const enforced = tenantEnforced();
  if (!shouldMeter({ enforced, keySource })) return { meter: false, allowed: true, state: null };
  if (!tenantId) return { meter: true, allowed: false, reason: 'tenant_required', state: null };
  let state;
  try {
    const theDb = typeof db === 'function' ? await db() : db;
    state = await checkBucket(theDb, tenantId);
  } catch (e) {
    console.error('[usage] bucket check failed — failing closed:', e?.message || e);
    return { meter: true, allowed: false, reason: 'metering_unavailable', state: null };
  }
  if (state.remaining < estCredits) {
    return { meter: true, allowed: false, reason: 'credits_exhausted', state };
  }
  return { meter: true, allowed: true, state };
}

/**
 * Write the HTTP response for a denied meterGate. Exhausted bucket is
 * the product case: 402 { error:'credits_exhausted', remaining } — the
 * client turns that into "you're out of credits" + the credit-pack
 * offer. The other two reasons are operator problems, shaped plainly.
 */
export function denyMetering(res, gate) {
  if (gate?.reason === 'metering_unavailable') {
    return res.status(503).json({ error: 'metering_unavailable' });
  }
  if (gate?.reason === 'tenant_required') {
    return res.status(401).json({ error: 'tenant_required' });
  }
  return res.status(402).json({
    error: 'credits_exhausted',
    remaining: gate?.state?.remaining ?? 0,
  });
}

/**
 * The after-success write, handler-shaped: a no-op unless the gate
 * decided to meter, and never throws (the provider call already
 * succeeded — see safeRecordUsage). db may be a pool or the getUsageDb
 * factory, exactly as in meterGate.
 * @returns {Promise<boolean>} true when a ledger row was inserted
 */
export async function recordMetered(gate, db, usage) {
  if (!gate?.meter) return false;
  try {
    const theDb = typeof db === 'function' ? await db() : db;
    return await safeRecordUsage(theDb, usage);
  } catch (e) {
    console.error('[usage] recordMetered failed (provider call already succeeded):', e?.message || e);
    return false;
  }
}

let _pool = null;

/**
 * Lazily build the shared pg pool for metering (same shape and env
 * resolution as server/handlers/memory.js getPool). Handlers pass the
 * result into the DB functions above. Never called by tests.
 */
export async function getUsageDb() {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL_MEMORY || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL_MEMORY (or DATABASE_URL) not set');
  const { Pool } = await import('pg');
  _pool = new Pool({
    connectionString: url,
    max: 3,
    idleTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: false },
  });
  return _pool;
}
