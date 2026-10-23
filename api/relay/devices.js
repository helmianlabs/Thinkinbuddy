// Physical route file for GET /api/relay/devices.
// See api/auth/login.js for why this shim exists (the generated
// catch-all route matches one segment only; physical files route
// exactly). Re-exports the pairing handler that owns /api/relay/*.
export { default } from '../../server/handlers/relay-pair.js';
