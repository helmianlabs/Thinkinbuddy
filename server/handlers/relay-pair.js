// api/relay-pair.js — Helmian Connect computer pairing for the hosted
// ThinkinBuddy (relay bite). Routes (the api/[...path].js router
// dispatches on the first path segment, so this handler owns
// /api/relay/*):
//   POST /api/relay/pair/create  (tenant session)
//        -> 200 { code, expiresAt }
//        | 403 { error: 'helmian_connect_required' } (any other plan)
//   POST /api/relay/pair/redeem  { code, deviceLabel }
//        -> 200 { deviceToken, deviceId, channel }
//        | 401 { error: 'invalid_or_expired_code' }
//   POST /api/relay/pair/revoke  (tenant session) { deviceId }
//        -> 200 { ok: true } | 404 { error: 'device_not_found' }
//   GET  /api/relay/devices      (tenant session)
//        -> 200 { devices: [{ id, device_label, paired_at,
//                             last_seen_at, revoked_at }] }
//
// Pairing is a HOSTED-mode concept (it exists to give one tenant's
// buddy hands on that tenant's computer), so in compat mode (no
// SESSION_SECRET — Troy's live single-user deployment, where the relay
// runs on its legacy personal wiring) every route answers
// 503 { error: 'accounts_not_configured' }, exactly like /api/auth and
// /api/profile.
//
// Who proves what:
//   - create/revoke/devices carry the parent's session token
//     (lib/tenant.js requireTenant) — a device list or a pairing code
//     is never minted for an id in the request body.
//   - redeem carries NO session: the computer being paired has no
//     account. The 6-digit code IS the credential — 10-minute life,
//     single-use, minted only by an entitled tenant (lib/relay.js).
//   - The raw deviceToken is returned by redeem EXACTLY ONCE. Only its
//     SHA-256 hash is stored, and no read path ever returns it again.

import {
  createPairingCode, redeemPairingCode, requireConnectEntitlement,
  listDevices, revokeDevice, channelForTenant, getRelayDb,
} from '../../lib/relay.js';
import { requireTenant, tenantEnforced } from '../../lib/tenant.js';

function routeOf(req) {
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://local').pathname;
  } catch {
    pathname = String(req.url || '');
  }
  if (/\/pair\/create\/?$/.test(pathname)) return 'create';
  if (/\/pair\/redeem\/?$/.test(pathname)) return 'redeem';
  if (/\/pair\/revoke\/?$/.test(pathname)) return 'revoke';
  if (/\/devices\/?$/.test(pathname)) return 'devices';
  return null;
}

/**
 * The route logic, with the db injected — the default export resolves
 * the real pool; tests call this with a fake db.
 * @param {import('pg').Pool | Function} db
 */
export async function handleRelayPair(req, res, db) {
  const route = routeOf(req);
  if (!route) return res.status(404).json({ error: 'not_found' });
  if (!tenantEnforced()) return res.status(503).json({ error: 'accounts_not_configured' });
  const body = req.body || {};

  try {
    // ── Redeem: the code is the credential, no session ──────────────
    if (route === 'redeem') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
      const redeemed = await redeemPairingCode(db, body.code, body.deviceLabel);
      if (!redeemed) return res.status(401).json({ error: 'invalid_or_expired_code' });
      return res.status(200).json({
        deviceToken: redeemed.deviceToken, // the ONLY time this is ever returned
        deviceId: redeemed.deviceId,
        channel: channelForTenant(redeemed.tenantId),
      });
    }

    // ── Everything else needs the parent's session ──────────────────
    const tenant = requireTenant(req, res);
    if (!tenant) return; // requireTenant wrote the 401
    const tenantId = tenant.tenantId;

    if (route === 'create') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
      // The Connect gate: pairing a computer is the Helmian Connect
      // feature itself, so no other plan can even mint a code.
      if (!(await requireConnectEntitlement(db, tenantId))) {
        return res.status(403).json({ error: 'helmian_connect_required' });
      }
      const { code, expiresAt } = await createPairingCode(db, tenantId);
      return res.status(200).json({ code, expiresAt });
    }

    if (route === 'revoke') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
      const revoked = await revokeDevice(db, tenantId, body.deviceId);
      if (!revoked) return res.status(404).json({ error: 'device_not_found' });
      return res.status(200).json({ ok: true });
    }

    // devices
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
    const devices = await listDevices(db, tenantId);
    return res.status(200).json({ devices });
  } catch (e) {
    console.error('[relay-pair] failed:', e?.message || e);
    return res.status(500).json({ error: 'internal' });
  }
}

export default async function handler(req, res) {
  return handleRelayPair(req, res, getRelayDb);
}
