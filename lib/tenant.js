// lib/tenant.js — session-token auth for the ThinkinBuddy store build.
//
// Store bite 1 (scaffold) + the wiring bite. This file is the foundation
// that replaces the hardcoded identity in lib/security.js, where
// genUserId() returns the string 'troy' for every user on every device.
// It mints, verifies, and resolves session tokens, and the core
// memory/conversation handlers (server/handlers/memory.js, recall-memory.js,
// conversation-turn.js, conversation-history.js, prime-agent.js,
// extract-memories.js, api/conversation-webhook.js) now resolve tenant_id
// through it — see docs/store/TENANT_WIRING.md.
//
// ─── COMPAT MODE (the hard rule for the wiring bite) ─────────────────────
// Troy's live single-user deployment has NO SESSION_SECRET set. In that
// state this module must not reject anything: resolveTenant /
// requireTenant return the LEGACY tenant (LEGACY_TENANT_ID, the single
// tenant sql/store/001+002 create and backfill every existing row to),
// and the handlers' scoping helper (resolveHandlerTenant /
// activeTenantId) reports "no scoping tenant", so every handler runs its
// original, pre-wiring queries byte-for-byte — user_id stays the identity
// column exactly as today, and no query references the tenant_id columns
// (which the live DB may not have yet).
//
// The moment SESSION_SECRET IS set (the hosted multi-tenant deployment,
// where sql/store/001+002 have been run), the same helpers flip to
// enforced mode: a missing or invalid token resolves to null,
// requireTenant writes a 401, and handlers scope every read/write to the
// resolved tenant_id. Handlers must branch on tenantEnforced() / the
// helpers below — never on a tenant value alone.
//
// TOKEN SHAPE: JWT-shaped, three base64url parts — header.payload.signature.
//   header    = {"alg":"HS256","typ":"JWT"}
//   payload   = {"sub": <tenantId>, "iat": <unix sec>, "exp": <unix sec>}
//   signature = HMAC-SHA256(secret, header + "." + payload), base64url
// The signing pattern follows the repo's existing signed-state code in
// lib/actionable/google-auth.js (signState/verifyState): base64url payload,
// HMAC-SHA256, and a length check before timingSafeEqual — timingSafeEqual
// throws on a length mismatch, so lengths are compared first.
//
// SECRET: process.env.SESSION_SECRET (server-side only, never shipped to
// the client, never logged). Callers may pass a secret explicitly; the
// resolve/require helpers default to the env value.
//
// ZERO new dependencies: node:crypto only.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_SECRET_ENV = 'SESSION_SECRET';

// The one tenant that exists before multi-tenant signup: created by
// sql/store/001_tenants.sql and used by sql/store/002_tenant_columns.sql
// to backfill every pre-wiring row. In compat mode (no SESSION_SECRET)
// resolveTenant returns this id, and in enforced mode rows written
// before the wiring bite belong to it.
export const LEGACY_TENANT_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Is tenant enforcement on? Enforcement is keyed to the presence of the
 * secret itself: SESSION_SECRET set (non-empty) = hosted multi-tenant
 * mode; unset/empty = compat mode (today's live single-user deployment).
 *
 * @param {string} [secret]  defaults to process.env.SESSION_SECRET
 */
export function tenantEnforced(secret = process.env[SESSION_SECRET_ENV]) {
  return typeof secret === 'string' && secret.length > 0;
}

/** UUID shape check (tenant ids are uuids; user_id values historically are not). */
export function isTenantId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

const DEFAULT_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function sign(secret, signingInput) {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

/**
 * Mint a session token for one tenant.
 * @param {string} tenantId  tenants.id (uuid)
 * @param {string} secret    SESSION_SECRET value
 * @param {number} [ttlSec]  lifetime in seconds (default 7 days)
 * @returns {string} header.payload.signature
 */
export function signSession(tenantId, secret, ttlSec = DEFAULT_TTL_SEC) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('signSession: tenantId is required');
  }
  if (!secret || typeof secret !== 'string') {
    throw new Error('signSession: secret is required (SESSION_SECRET)');
  }
  const now = Math.floor(Date.now() / 1000);
  const ttl = Number.isFinite(ttlSec) && ttlSec > 0 ? Math.floor(ttlSec) : DEFAULT_TTL_SEC;
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const payload = b64urlJson({ sub: tenantId, iat: now, exp: now + ttl });
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign(secret, signingInput)}`;
}

/**
 * Verify a session token.
 * @param {string} token
 * @param {string} secret  SESSION_SECRET value
 * @returns {{ tenantId: string } | null} null for anything malformed,
 *   tampered, expired, or signed with a different secret. Never throws.
 */
export function verifySession(token, secret) {
  if (!token || typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, suppliedSig] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') return null;

  const expectedSig = sign(secret, `${headerPart}.${payloadPart}`);
  const a = Buffer.from(suppliedSig);
  const e = Buffer.from(expectedSig);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (a.length !== e.length || !timingSafeEqual(a, e)) return null;

  if (!payload || typeof payload.sub !== 'string' || !payload.sub) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;

  return { tenantId: payload.sub };
}

function authorizationHeader(req) {
  const headers = req?.headers || {};
  let value = headers.authorization;
  if (!value) {
    // Node lower-cases incoming header names; be tolerant of proxies and
    // hand-built request objects that don't (same tolerance as
    // lib/userKeys.js).
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'authorization') { value = v; break; }
    }
  }
  if (Array.isArray(value)) value = value[0];
  return typeof value === 'string' ? value : null;
}

/**
 * Resolve the tenant for one request from its Authorization header.
 * @param {object} req  request with .headers
 * @param {string} [secret]  defaults to process.env.SESSION_SECRET
 * @returns {{ tenantId: string } | null} Enforced mode (SESSION_SECRET
 *   set): null when the header is absent, not a Bearer token, or the
 *   token does not verify. Compat mode (no SESSION_SECRET): always
 *   { tenantId: LEGACY_TENANT_ID } — see the header comment.
 */
export function resolveTenant(req, secret = process.env[SESSION_SECRET_ENV]) {
  // COMPAT MODE: no SESSION_SECRET (today's live deployment) -> the
  // legacy tenant, never a rejection. See the header comment: callers
  // that scope queries must use tenantEnforced()/activeTenantId(),
  // because in compat mode this id is an identity placeholder, not a
  // query filter.
  if (!tenantEnforced(secret)) return { tenantId: LEGACY_TENANT_ID };
  const header = authorizationHeader(req);
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  return verifySession(match[1].trim(), secret);
}

/**
 * The tenant_id a handler should actually scope its queries by, given a
 * tenant previously returned by resolveTenant/requireTenant. Compat
 * mode yields null (= run the original unscoped queries, exactly as
 * before the wiring bite); enforced mode yields the resolved tenant id.
 * @param {{ tenantId: string } | null} tenant
 * @param {string} [secret]  defaults to process.env.SESSION_SECRET
 * @returns {string | null}
 */
export function activeTenantId(tenant, secret = process.env[SESSION_SECRET_ENV]) {
  if (!tenantEnforced(secret)) return null;
  return tenant?.tenantId ?? null;
}

/**
 * Resolve the scoping tenant for the tool/webhook-style handlers, whose
 * callers (ElevenLabs agent tools, the browser's per-turn capture)
 * carry identity in the request instead of a session-token header. Two
 * sources, in order:
 *   1. An Authorization: Bearer session token on the request, if one
 *      verifies (the hosted browser client sends it).
 *   2. The caller-supplied user_id value, which in hosted mode IS the
 *      tenant id: prime-agent returns the tenant id for the session
 *      and the client sets it as the ElevenLabs widget's `user_id`
 *      dynamic variable (index.html), so every tool call and the
 *      post-call webhook session metadata carry it (see
 *      api/conversation-webhook.js).
 * @param {object} req  request with .headers
 * @param {string} [candidateUserId]  the userId/user_id value from the
 *   request body, query, or ElevenLabs session metadata
 * @param {string} [secret]  defaults to process.env.SESSION_SECRET
 * @returns {{ tenantId: string | null, enforced: boolean, ok: boolean }}
 *   Compat mode: { tenantId: null, enforced: false, ok: true } — the
 *   caller runs its original queries. Enforced mode: ok is true and
 *   tenantId set when a token or a UUID-shaped candidate resolved; ok
 *   is false (tenantId null) when NEITHER did — the caller must
 *   reject, never fall back to a default tenant.
 */
export function resolveHandlerTenant(req, candidateUserId, secret = process.env[SESSION_SECRET_ENV]) {
  if (!tenantEnforced(secret)) return { tenantId: null, enforced: false, ok: true };
  const fromToken = resolveTenant(req, secret);
  if (fromToken) return { tenantId: fromToken.tenantId, enforced: true, ok: true };
  if (isTenantId(candidateUserId)) return { tenantId: candidateUserId, enforced: true, ok: true };
  return { tenantId: null, enforced: true, ok: false };
}

function send401(res) {
  const body = { error: 'Unauthorized' };
  if (res && typeof res.status === 'function' && typeof res.json === 'function') {
    res.status(401).json(body);
    return;
  }
  if (res && typeof res.writeHead === 'function' && typeof res.end === 'function') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

/**
 * Gate a handler on a valid session. Returns { tenantId } on success;
 * on failure writes a 401 JSON response and returns null — the caller
 * must stop when it gets null:
 *   const tenant = requireTenant(req, res);
 *   if (!tenant) return;
 * @param {string} [secret]  defaults to process.env.SESSION_SECRET
 */
export function requireTenant(req, res, secret = process.env[SESSION_SECRET_ENV]) {
  const tenant = resolveTenant(req, secret);
  if (!tenant) {
    send401(res);
    return null;
  }
  return tenant;
}

/**
 * Keep only the rows that belong to one tenant. Rows are plain objects
 * carrying the tenant_id column added by sql/store/002_tenant_columns.sql.
 * This is the in-code mirror of the WHERE tenant_id = $1 filter every
 * query takes in the wiring bite, and the helper the isolation test uses.
 * @param {Array<object>} rows
 * @param {string} tenantId
 * @returns {Array<object>} the tenant's rows, original order preserved
 */
export function tenantPredicate(row, tenantId) {
  // The scoping predicate: a row belongs to a tenant iff its tenant_id
  // column (sql/store/002) equals the tenant. This is the row-level
  // mirror of the `AND tenant_id = $n` clause the wired handlers add
  // to every SQL read in enforced mode.
  if (!row || !tenantId) return false;
  return row.tenant_id === tenantId;
}

export function scopeToTenant(rows, tenantId) {
  if (!Array.isArray(rows) || !tenantId) return [];
  return rows.filter((row) => tenantPredicate(row, tenantId));
}
