// api/auth.js — account signup + login for the hosted ThinkinBuddy
// (accounts bite). Routes (the api/[...path].js router dispatches on the
// first path segment, so this one handler owns /api/auth/*):
//   POST /api/auth/signup { email, password } -> 201 { token, tenantId }
//   POST /api/auth/login  { email, password } -> 200 { token, tenantId }
//                                              | 401 { error: 'invalid_credentials' }
//
// Identity itself lives in lib/accounts.js (scrypt password storage,
// tenant + empty profile + free entitlement created at signup); this
// handler is the HTTP shape + the session token (lib/tenant.js
// signSession, the same token every other handler already verifies).
//
// Accounts are a HOSTED-mode concept: they exist so the shared
// deployment can tell tenants apart, which is exactly what
// SESSION_SECRET switches on. In compat mode (no SESSION_SECRET —
// Troy's live single-user deployment) there are no accounts to create,
// so both routes answer 503 { error: 'accounts_not_configured' }
// instead of minting tokens nobody could verify.
//
// Login failures are deliberately indistinguishable: unknown email and
// wrong password both produce the identical 401 body (lib/accounts.js
// also runs a dummy verify so the TIMING matches).

import { createAccount, authenticate, getAccountsDb } from '../../lib/accounts.js';
import { signSession, tenantEnforced } from '../../lib/tenant.js';

function routeOf(req) {
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://local').pathname;
  } catch {
    pathname = String(req.url || '');
  }
  if (/\/signup\/?$/.test(pathname)) return 'signup';
  if (/\/login\/?$/.test(pathname)) return 'login';
  return null;
}

/**
 * The route logic, with the db injected — the default export resolves
 * the real pool; tests call this with a fake db.
 * @param {import('pg').Pool | Function} db
 */
export async function handleAuth(req, res, db) {
  const route = routeOf(req);
  if (!route) return res.status(404).json({ error: 'not_found' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!tenantEnforced()) return res.status(503).json({ error: 'accounts_not_configured' });

  const { email, password } = req.body || {};
  try {
    if (route === 'signup') {
      let created;
      try {
        created = await createAccount(db, { email, password });
      } catch (e) {
        if (e?.code === 'email_taken') return res.status(409).json({ error: 'email_taken' });
        if (e?.code === 'invalid_email') return res.status(400).json({ error: 'invalid_email' });
        if (e?.code === 'weak_password') return res.status(400).json({ error: 'weak_password' });
        throw e;
      }
      const token = signSession(created.tenantId, process.env.SESSION_SECRET);
      return res.status(201).json({ token, tenantId: created.tenantId });
    }
    // login
    const auth = await authenticate(db, { email, password });
    if (!auth) return res.status(401).json({ error: 'invalid_credentials' });
    const token = signSession(auth.tenantId, process.env.SESSION_SECRET);
    return res.status(200).json({ token, tenantId: auth.tenantId });
  } catch (e) {
    console.error('[auth] failed:', e?.message || e);
    return res.status(500).json({ error: 'internal' });
  }
}

export default async function handler(req, res) {
  return handleAuth(req, res, getAccountsDb);
}
