// Physical route file for POST /api/relay/pair/redeem.
// See api/auth/login.js for why this shim exists (the generated
// catch-all route matches one segment only; physical files route
// exactly). Re-exports the pairing handler that owns /api/relay/*.
// This route is called by the Helmian desktop spoke, not the web
// client — the pairing code is the credential, no session.
export { default } from '../../../server/handlers/relay-pair.js';
