// lib/safety.js — parent safety-mode decisions + PIN helpers for the
// ThinkinBuddy store build (child-safety bite).
//
// Troy's standing safety model (decided 2026-10-16):
//   - A parent turns safety mode ON, and the setting is protected by a
//     PIN so a kid can't flip it back off.
//   - Underneath sit hardcoded, non-negotiable guardrails that NO toggle
//     disables (those live in lib/personality.js: BASE_GUARDRAILS, with
//     KID_SAFETY_CORE as the stricter layer) — this file only DECIDES
//     which layers apply to a request and guards the PIN itself.
//   - The OpenAI Moderation API (free) is the content layer
//     (lib/moderation.js); when safety applies to a request, moderation
//     must FAIL CLOSED — an unscreened request is a refused request.
//
// This file is deliberately profile-free: it does not read any profile
// store. Handlers derive { safetyMode, ageBand } from whatever request
// plumbing they already have (see safetyInputsFromRequest) until the
// onboarding bite wires real per-tenant profiles in.
//
// ZERO new dependencies: node:crypto only (same rule as lib/tenant.js).

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// ─── Age bands ──────────────────────────────────────────────────────────
//
// MINOR RULE (documented, deliberate): an age band marks the user as a
// minor for safety purposes when the band describes a child under 13:
//   - the literal band 'child' (or any band containing 'child');
//   - an explicit under-13 band ('under-13', 'under13', '<13');
//   - a range whose LOW end is below 13 ('6-8', '9-12', '0-5', '10-12');
//   - a single age below 13 ('7', '12').
// Bands that start at 13 ('13-17', 'teen', 'adult', '18+') are NOT minor
// under this rule. That is the COPPA under-13 line the store plan uses;
// widening it to all under-18 bands is a one-line change here if Troy
// decides otherwise — every caller goes through this one function.
export function isMinorAgeBand(ageBand) {
  if (typeof ageBand !== 'string') return false;
  const band = ageBand.trim().toLowerCase();
  if (!band) return false;
  if (band.includes('child')) return true;
  if (/^(under[-\s]?13|<\s?13)$/.test(band)) return true;
  const range = /^(\d{1,2})\s*[-–]\s*(\d{1,2})$/.exec(band);
  if (range) return Number(range[1]) < 13;
  const single = /^(\d{1,2})\+?$/.exec(band);
  if (single) return Number(single[1]) < 13;
  return false;
}

// ─── The decision ───────────────────────────────────────────────────────

/**
 * Decide which safety layers apply to one request.
 * @param {object} input
 * @param {boolean} [input.safetyMode=false]  parent-turned-on safety mode
 * @param {string|null} [input.ageBand=null]  the user's age band, if known
 * @returns {{ failClosed: boolean, kidCore: boolean }}
 *   failClosed — moderation (lib/moderation.js) must refuse when it
 *     cannot screen (missing key / API error / timeout), instead of its
 *     historical fail-open default.
 *   kidCore — the KID_SAFETY_CORE layer (lib/personality.js) applies.
 *   Both are true exactly when safety mode is on OR the age band is a
 *   minor band: safety is not optional for kids, PIN or no PIN.
 */
export function safetyDecision({ safetyMode = false, ageBand = null } = {}) {
  const applies = safetyMode === true || isMinorAgeBand(ageBand);
  return { failClosed: applies, kidCore: applies };
}

/**
 * Pull { safetyMode, ageBand } out of the request plumbing the handlers
 * ALREADY have — top-level body fields, the chat handler's userContext,
 * or query params (the tool-webhook handlers accept both). Returns the
 * neutral defaults (false / null) when nothing is present; it invents
 * nothing and reads no store. The onboarding bite replaces these sources
 * with the tenant profile — callers keep calling this one function.
 * @param {object} req  request with .body / .query
 * @returns {{ safetyMode: boolean, ageBand: string|null }}
 */
export function safetyInputsFromRequest(req) {
  const body = req?.body || {};
  const query = req?.query || {};
  const ctx = (body && typeof body.userContext === 'object' && body.userContext) || {};
  const safetyMode = [body.safetyMode, ctx.safetyMode, query.safetyMode]
    .some((v) => v === true || v === 'true' || v === '1');
  const ageBand = [body.ageBand, ctx.ageBand, query.ageBand]
    .find((v) => typeof v === 'string' && v.trim()) || null;
  return { safetyMode, ageBand };
}

// ─── Parent PIN ─────────────────────────────────────────────────────────
//
// Stored format: "<salt hex>:<hash hex>" — scrypt with a per-PIN random
// salt. The PIN itself is never stored, never logged, and verification
// is timing-safe (length check first: timingSafeEqual throws on a
// length mismatch — same pattern as lib/tenant.js).

const PIN_SALT_BYTES = 16;
const PIN_KEY_LEN = 32;

/**
 * Hash a parent PIN for storage (profiles.parent_pin_hash,
 * sql/store/001_tenants.sql).
 * @param {string} pin
 * @returns {string} "salt:hash" (hex)
 */
export function hashPin(pin) {
  if (typeof pin !== 'string' || pin.length === 0) {
    throw new Error('hashPin: pin is required');
  }
  const salt = randomBytes(PIN_SALT_BYTES);
  const hash = scryptSync(pin, salt, PIN_KEY_LEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Check a PIN against a stored hashPin value.
 * @param {string} pin
 * @param {string} stored  a value previously produced by hashPin
 * @returns {boolean} false for a wrong PIN and for any malformed stored
 *   value. Never throws.
 */
export function verifyPin(pin, stored) {
  if (typeof pin !== 'string' || typeof stored !== 'string') return false;
  const sep = stored.indexOf(':');
  if (sep <= 0) return false;
  const salt = Buffer.from(stored.slice(0, sep), 'hex');
  const expected = Buffer.from(stored.slice(sep + 1), 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(pin, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
