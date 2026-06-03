// lib/safeBrowse.js — kid-safe URL + query guards for browse.js / search.js.
//
// Two exports:
//   isSafeUrl(url)     -> { safe: bool, reason: string|null }
//   isSafeQuery(query) -> { safe: bool, reason: string|null }
//
// This is a cheap, deterministic FIRST gate (no network). Layer 2 moderation
// (lib/moderation.js) is the SECOND gate that screens the actual query text and
// fetched page content. Defense in depth: this catches obvious adult/unsafe
// destinations before we ever fetch them.

// Known adult / unsafe domains (host substring match, so subdomains are caught
// too). Small, high-signal list — not exhaustive, the token scan below + Layer 2
// moderation cover the long tail.
const BLOCKED_DOMAINS = [
  'pornhub', 'xvideos', 'xhamster', 'xnxx', 'redtube', 'youporn', 'spankbang',
  'onlyfans', 'chaturbate', 'brazzers', 'rule34', 'e-hentai', 'nhentai',
  'fapello', 'motherless', 'tnaflix', 'cam4', 'stripchat', 'bongacams',
  'adultfriendfinder', 'ashleymadison', 'pornpics', 'hentaihaven',
];

// Adult/unsafe TLDs.
const BLOCKED_TLDS = ['.xxx', '.porn', '.adult', '.sex', '.sexy', '.cam', '.tube'];

// Tokens that, if present anywhere in the host, flag the URL as unsafe.
// Word-boundary-ish: we match these as host substrings since porn-domains
// rarely use separators. Kept tight to avoid false positives like "essex".
const HOST_TOKENS = ['porn', 'xxx', 'nsfw', 'hentai', 'camgirl', 'escort', 'fetish'];

// "sex"/"adult" as standalone host labels (avoid matching "essex", "adultedu").
const HOST_LABEL_TOKENS = ['sex', 'adult', 'nude', 'nudes', 'milf', 'bdsm'];

// Query tokens that flag an obviously-unsafe search before we even run it.
// Layer 2 moderation is the real semantic gate; this is the fast obvious catch.
const QUERY_TOKENS = [
  'porn', 'pornhub', 'xxx', 'xvideos', 'hentai', 'nsfw', 'nude', 'nudes',
  'sex video', 'sex tape', 'naked', 'milf', 'onlyfans leak', 'camgirl',
  'how to make a bomb', 'how to make meth', 'buy drugs', 'kill myself',
  'how to kill', 'child porn', 'cp ',
];

/**
 * @param {string} url
 * @returns {{safe: boolean, reason: string|null}}
 */
export function isSafeUrl(url) {
  if (!url || typeof url !== 'string') return { safe: false, reason: 'empty url' };

  let host;
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    host = u.hostname.toLowerCase();
  } catch {
    return { safe: false, reason: 'invalid url' };
  }

  for (const d of BLOCKED_DOMAINS) {
    if (host.includes(d)) return { safe: false, reason: `blocked domain (${d})` };
  }
  for (const tld of BLOCKED_TLDS) {
    if (host.endsWith(tld)) return { safe: false, reason: `blocked tld (${tld})` };
  }
  for (const t of HOST_TOKENS) {
    if (host.includes(t)) return { safe: false, reason: `unsafe host token (${t})` };
  }
  // Label-level match for short tokens to avoid false positives.
  const labels = host.split('.');
  for (const label of labels) {
    if (HOST_LABEL_TOKENS.includes(label)) {
      return { safe: false, reason: `unsafe host label (${label})` };
    }
  }

  return { safe: true, reason: null };
}

/**
 * @param {string} query
 * @returns {{safe: boolean, reason: string|null}}
 */
export function isSafeQuery(query) {
  if (!query || typeof query !== 'string') return { safe: false, reason: 'empty query' };
  const q = ` ${query.toLowerCase()} `;
  for (const t of QUERY_TOKENS) {
    if (q.includes(t)) return { safe: false, reason: `unsafe query token (${t.trim()})` };
  }
  // If the query is just a URL, run it through the URL guard too.
  if (/^https?:\/\//i.test(query.trim()) || /\.[a-z]{2,}\//i.test(query.trim())) {
    const u = isSafeUrl(query.trim());
    if (!u.safe) return u;
  }
  return { safe: true, reason: null };
}

// Speakable refusals so browse/search sound consistent to the buddy.
export const UNSAFE_SITE_MSG = "I can't open that one — it's not a kid-safe site. Want to look up something else?";
export const UNSAFE_QUERY_MSG = "Let's search for something else — that's not something I can look up.";
