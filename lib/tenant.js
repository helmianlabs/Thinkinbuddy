// lib/tenant.js — session-token auth for the ThinkinBuddy store build.
//
// Store bite 1 (scaffold). This file is the foundation that replaces the
// hardcoded identity in lib/security.js, where genUserId() returns the
// string 'troy' for every user on every device. Nothing calls this yet —
// docs/store/TENANT_WIRING.md lists every handler the next bite threads
// tenant_id through. This file only mints, verifies, and resolves tokens.
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
 * @returns {{ tenantId: string } | null} null when the header is absent,
 *   not a Bearer token, or the token does not verify.
 */
export function resolveTenant(req, secret = process.env[SESSION_SECRET_ENV]) {
  const header = authorizationHeader(req);
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  return verifySession(match[1].trim(), secret);
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
export function scopeToTenant(rows, tenantId) {
  if (!Array.isArray(rows) || !tenantId) return [];
  return rows.filter((row) => row && row.tenant_id === tenantId);
}
