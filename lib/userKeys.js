// lib/userKeys.js — resolve a provider credential for one request.
//
// Order of preference:
//   1. The caller's own key, supplied as an X-User-Key-<PROVIDER> header by
//      the browser (see apiFetch in index.html). Stored only in that user's
//      localStorage; it reaches the server on the request that needs it and
//      is never persisted, never logged.
//   2. The server's process.env value — today's behaviour, unchanged, so a
//      user who configures nothing keeps working exactly as before.
//
// Header naming mirrors the env var with the trailing _API_KEY / _API_TOKEN
// stripped, e.g. OPENAI_API_KEY -> X-User-Key-OPENAI.
//
// NEVER log the return value of any function in this file.

/** Env var name -> the header suffix the browser sends. */
export function headerNameFor(envVar) {
  return `x-user-key-${envVar.replace(/_API_KEY$|_API_TOKEN$/, '').toLowerCase()}`;
}

/**
 * Resolve one credential for this request.
 * @param {import('http').IncomingMessage} req
 * @param {string} envVar e.g. 'OPENAI_API_KEY'
 * @returns {{ key: string|null, source: 'user'|'env'|'none' }}
 */
export function resolveKey(req, envVar) {
  const headers = req?.headers || {};
  // Node lower-cases incoming header names; be tolerant of proxies that don't.
  const wanted = headerNameFor(envVar);
  let supplied = headers[wanted];
  if (!supplied) {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === wanted) { supplied = v; break; }
    }
  }
  if (Array.isArray(supplied)) supplied = supplied[0];
  if (typeof supplied === 'string' && supplied.trim()) {
    return { key: supplied.trim(), source: 'user' };
  }
  const fromEnv = process.env[envVar];
  if (fromEnv && String(fromEnv).trim()) {
    return { key: String(fromEnv).trim(), source: 'env' };
  }
  return { key: null, source: 'none' };
}

/**
 * Same as resolveKey but returns only the key, or null.
 * Convenience for call sites that don't care where it came from.
 */
export function getKey(req, envVar) {
  return resolveKey(req, envVar).key;
}

/**
 * Standard "no credential anywhere" response body.
 * Names the env var AND points at the in-app settings, so the user can fix it
 * from either side without reading the source.
 */
export function missingKeyError(envVar) {
  return {
    error: `No credential for ${envVar}.`,
    fix: `Add your key under Settings → Keys in the app, or set ${envVar} in the server environment.`,
    envVar,
  };
}
