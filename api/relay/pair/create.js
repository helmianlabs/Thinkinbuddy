// Physical route file for POST /api/relay/pair/create.
// See api/auth/login.js for why this shim exists (the generated
// catch-all route matches one segment only; physical files route
// exactly). Re-exports the pairing handler that owns /api/relay/*
// (server/handlers/relay-pair.js — it sub-routes by URL suffix).
export { default } from '../../../server/handlers/relay-pair.js';
