// lib/actionable/integrations/provider.js
// ---------------------------------------------------------------------------
// The provider contract. Adding a service is ONE file implementing this shape
// plus one line in registry.js — never a change to the capture pipeline, the
// API routes, or the app.
//
// THREE CONNECTION KINDS, because the real world has three:
//
//   'oauth'   The user taps Connect, approves on the service's own screen, and
//             never sees a token. Google, Todoist, Notion, Slack.
//
//   'url'     The service hands the USER a secret URL and expects you to POST to
//             it. Zapier Catch Hooks and Make Custom Webhooks work exactly this
//             way — there is no OAuth to do, because the URL IS the credential.
//             This is not laziness: building a published Zapier app requires
//             owning the API you integrate plus a mandatory 90-day beta, which
//             is the wrong trade for a small app.
//
//   'script'  A user-deployed Google Apps Script /exec URL. Runs as the user,
//             needs no OAuth client at all. This is what Troy's existing Claude
//             AI Memory Vault uses, and it is why that one works today with no
//             login — see docs/ACTIONABLE_SETUP.md.
//
// A provider declares which kinds of item it can meaningfully receive. A task
// manager should not be sent a rambling note, and a notes app should not be sent
// eight separate one-line tasks. `accepts` is what stops the push screen
// offering nonsense.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Provider
 * @property {string}   id            stable slug, used as the DB key
 * @property {string}   name          shown on the Connect button
 * @property {string}   blurb         one line, plain language, no jargon
 * @property {'oauth'|'url'|'script'} kind
 * @property {string[]} accepts       item kinds this service can receive
 * @property {string}   [docsUrl]     where the user goes to get their URL (kind url/script)
 * @property {string}   [urlLabel]    label for the URL field
 * @property {string}   [urlHint]     placeholder / example
 * @property {string}   [note]        a caveat the user MUST see before connecting
 * @property {() => boolean}  isConfigured   server env present for this provider?
 * @property {(state:string) => string} [buildAuthUrl]
 * @property {(code:string) => Promise<Tokens>} [exchangeCode]
 * @property {(refresh:string) => Promise<Tokens>} [refresh]
 * @property {(ctx:PushContext) => Promise<PushResult>} push
 */

/**
 * @typedef {object} Tokens
 * @property {string}  access_token
 * @property {string} [refresh_token]
 * @property {number} [expires_in]
 * @property {string} [account_label]   e.g. an email or workspace name
 * @property {object} [config]          provider-specific, stored as jsonb
 */

/**
 * @typedef {object} PushContext
 * @property {object}   entry       the normalized entry (see lib/actionable/extract.js)
 * @property {object[]} items       the SUBSET of entry.items the user chose to send
 * @property {string}   transcript
 * @property {string}   accessToken  '' for kind 'url' / 'script'
 * @property {string}   targetUrl    the user-supplied URL, for kind 'url' / 'script'
 * @property {object}   config       whatever the provider stored at connect time
 * @property {string}   timezone
 * @property {Date}     capturedAt
 */

/**
 * @typedef {object} PushResult
 * @property {boolean}  ok
 * @property {number}   [count]   how many things were created
 * @property {string}   [url]     a link to what was created, when there is one
 * @property {string}   [reason]  why it failed, in words a human can act on
 */

// Shared fetch helper. Every provider uses it so that a failure reads the same
// way regardless of which service broke, and so no provider can hang the request.
export async function apiFetch(url, init = {}, { timeoutMs = 20_000, label = 'service' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') throw new Error(`${label} did not respond in time`);
    throw new Error(`Could not reach ${label}: ${e?.message || e}`);
  }
  clearTimeout(timer);

  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* some APIs answer 204/empty */ }

  if (!resp.ok) {
    const detail = json?.error?.message || json?.error_description || json?.error || json?.message || text.slice(0, 200);
    throw new Error(`${label} returned ${resp.status}: ${detail}`);
  }
  return json ?? {};
}

// Most task services want a flat "do this by then" line. One place to build it,
// so every provider phrases an item the same way.
export function itemToLine(item) {
  return item.text;
}

export function itemDueIso(item) {
  return item.due?.iso || null;
}

// Plain-text rendering of a whole entry, for services that take a body of text
// (a webhook payload preview, a Slack message, a Notion page body).
export function entryToMarkdown(entry, items, transcript) {
  const L = [];
  if (entry.summary) { L.push(entry.summary); L.push(''); }
  for (const it of items) {
    const bits = [];
    if (it.priority === 'high') bits.push('HIGH');
    if (it.due?.raw) bits.push(`due ${it.due.raw}`);
    if (it.project) bits.push(it.project);
    L.push(`- ${it.text}${bits.length ? `  (${bits.join(' · ')})` : ''}`);
    if (it.detail) L.push(`  ${it.detail}`);
  }
  if (entry.numbers?.length) {
    L.push('');
    L.push('Numbers:');
    for (const n of entry.numbers) L.push(`- ${n.label}: ${n.value}${n.unit ? ` ${n.unit}` : ''}`);
  }
  if (transcript) { L.push(''); L.push(`Transcript: ${transcript}`); }
  return L.join('\n');
}
