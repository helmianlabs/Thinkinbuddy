// api/profile.js — the tenant's own profile for the hosted
// ThinkinBuddy (accounts bite). Routes (router dispatches on the first
// path segment, so this handler owns /api/profile/*):
//   GET  /api/profile            -> profile + entitlement plan
//   PUT  /api/profile            -> update whitelisted fields
//   POST /api/profile/pin        { pin } -> set/replace the parent PIN
//   POST /api/profile/pin/verify { pin } -> { ok: boolean }
//
// Auth: a valid session token (lib/tenant.js requireTenant) — a profile
// belongs to exactly the tenant in the token, never to an id in the
// request. Profiles are a hosted-mode concept: in compat mode (no
// SESSION_SECRET) this answers 503 { error: 'accounts_not_configured' },
// same as /api/auth.
//
// TROY'S PIN RULE: turning safety_mode OFF requires the parent PIN
// when one is set — a kid holding the phone must not be able to flip
// safety off. The check happens HERE, before the write: PUT with
// safety_mode:false while a PIN is set needs { pin } in the same
// request, verified against the stored hash. When NO pin is set yet,
// turning safety off is allowed (there is nothing to bypass — the
// parent has not armed the lock) but the response says so plainly:
// { pinSet: false, warning: 'no_parent_pin_set' }.
//
// Serialization is an explicit whitelist: parent_pin_hash and any other
// credential material NEVER leave the server. The response carries
// pin_set (a boolean) so the client can show "PIN is set" without ever
// seeing the hash.

import {
  getProfile, upsertProfile, setParentPin, verifyParentPin,
  getProfileDb, PROFILE_FIELDS,
} from '../../lib/profile.js';
import { getEntitlement } from '../../lib/usage.js';
import { requireTenant, tenantEnforced } from '../../lib/tenant.js';

function routeOf(req) {
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://local').pathname;
  } catch {
    pathname = String(req.url || '');
  }
  if (/\/pin\/verify\/?$/.test(pathname)) return 'pin-verify';
  if (/\/pin\/?$/.test(pathname)) return 'pin';
  return 'root';
}

/** Whitelisted public shape of a profile row. No hash material, ever. */
export function publicProfile(profile) {
  return {
    display_name: profile?.display_name ?? null,
    age_band: profile?.age_band ?? null,
    about_me: profile?.about_me ?? null,
    safety_mode: profile?.safety_mode === true,
    pin_set: Boolean(profile?.parent_pin_hash),
  };
}

/**
 * The route logic, with the db injected — the default export resolves
 * the real pool; tests call this with a fake db.
 * @param {import('pg').Pool | Function} db
 */
export async function handleProfile(req, res, db) {
  if (!tenantEnforced()) return res.status(503).json({ error: 'accounts_not_configured' });
  const tenant = requireTenant(req, res);
  if (!tenant) return; // requireTenant wrote the 401
  const tenantId = tenant.tenantId;
  const route = routeOf(req);
  const body = req.body || {};

  try {
    if (route === 'pin') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
      try {
        await setParentPin(db, tenantId, body.pin);
      } catch (e) {
        if (e?.code === 'invalid_pin') return res.status(400).json({ error: 'invalid_pin' });
        throw e;
      }
      return res.status(200).json({ ok: true, pinSet: true });
    }

    if (route === 'pin-verify') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
      const ok = await verifyParentPin(db, tenantId, body.pin);
      return res.status(200).json({ ok });
    }

    // root: GET / PUT
    if (req.method === 'GET') {
      const [profile, entitlement] = await Promise.all([
        getProfile(db, tenantId),
        getEntitlement(typeof db === 'function' ? await db() : db, tenantId).catch(() => null),
      ]);
      return res.status(200).json({
        tenantId,
        ...publicProfile(profile),
        plan: entitlement?.plan ?? null,
        entitlement_status: entitlement?.status ?? null,
      });
    }

    if (req.method === 'PUT') {
      const fields = {};
      for (const f of PROFILE_FIELDS) {
        if (body[f] !== undefined) fields[f] = body[f];
      }
      // Troy's PIN rule (see the header): safety OFF is a parent act.
      let warning = null;
      if (fields.safety_mode === false) {
        const current = await getProfile(db, tenantId);
        if (current?.safety_mode === true) {
          if (current.parent_pin_hash) {
            if (typeof body.pin !== 'string' || !body.pin) {
              return res.status(403).json({ error: 'parent_pin_required' });
            }
            if (!(await verifyParentPin(db, tenantId, body.pin))) {
              return res.status(403).json({ error: 'invalid_parent_pin' });
            }
          } else {
            warning = 'no_parent_pin_set';
          }
        }
      }
      let updated;
      try {
        updated = await upsertProfile(db, tenantId, fields);
      } catch (e) {
        if (e?.code === 'invalid_age_band') return res.status(400).json({ error: 'invalid_age_band' });
        if (e?.code === 'invalid_field') return res.status(400).json({ error: 'invalid_field' });
        throw e;
      }
      const response = {
        tenantId,
        ...publicProfile(updated),
        pinSet: Boolean(updated?.parent_pin_hash),
      };
      if (warning) response.warning = warning;
      return res.status(200).json(response);
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error('[profile] failed:', e?.message || e);
    return res.status(500).json({ error: 'internal' });
  }
}

export default async function handler(req, res) {
  return handleProfile(req, res, getProfileDb);
}
