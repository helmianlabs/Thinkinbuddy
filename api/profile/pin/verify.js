// Physical route file for POST /api/profile/pin/verify.
// See api/auth/login.js for why this shim exists (the generated
// catch-all route matches one segment only; physical files route
// exactly). Re-exports the handler that owns /api/profile/*.
export { default } from '../../../server/handlers/profile.js';
