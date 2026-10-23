// Physical route file for POST /api/auth/login.
//
// Why this file exists: the single-function router (api/[...path].js)
// is correct in code, but in this Vite-framework build Vercel emits
// the catch-all's route as a ONE-segment pattern — /api/<name> reaches
// the router, anything deeper (/api/auth/login) dies at the platform
// with a plain-text NOT_FOUND before any function runs (verified live
// against the store-test preview, 2026-10-23: /api/auth and
// /api/relay-pair return handler JSON, /api/auth/login returns the
// platform 404 page). A physical file routes exactly, so this shim
// re-exports the handler that owns /api/auth/* — it sub-routes by URL
// suffix, so it sees the original path unchanged. Pinned by
// test/routing.test.mjs.
export { default } from '../../server/handlers/auth.js';
