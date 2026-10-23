// lib/moderation.js — kid-safe content gate using OpenAI's FREE moderation API.
//
// One export: isAllowed(text, apiKey, options?) -> { allowed: bool, reason: string|null }
//   options.failClosed (default false): when screening is REQUIRED for
//   this request (safety mode on, or a minor's age band — see
//   lib/safety.js safetyDecision), an UNSCREENED text must not pass:
//   missing key / API error / timeout / malformed response all return
//   { allowed:false, reason:'moderation_unavailable' }. Callers pass
//   failClosed from safetyDecision; the default keeps the historical
//   behaviour below, byte-for-byte.
//
// Used by the generation endpoints (image / image-flux / video /
// video-runway / video-runway-veo / video-heygen / speak) and chat.js to
// screen user input and any prompt we're about to send to a provider,
// BEFORE the provider call.
//
// FAIL POLICY (deliberate, for a kids app):
//   - Flagged result            -> FAIL CLOSED (allowed:false). We refuse.
//   - Network / API error        -> FAIL OPEN (allowed:true) + console.error.
//     Rationale: a transient OpenAI hiccup must not brick the buddy for every
//     kid mid-sentence. Layer 1 (the immutable system prompt) and Layer 3
//     (safe-browse denylist) are still in force, so fail-open here is the
//     least-bad failure mode. The miss is logged so it's visible.
//     (failClosed:true flips exactly these cases to a refusal.)
//   - No apiKey / empty text     -> FAIL OPEN (nothing to check / can't check).
//     (failClosed:true flips the no-apiKey case to a refusal; empty text
//     is still allowed — there is nothing to screen.)
//
// Endpoint: POST https://api.openai.com/v1/moderations
//   body { model:"omni-moderation-latest", input:"..." }
//   resp { results:[{ flagged:bool, categories:{...} }] }

const MODEL = 'omni-moderation-latest';
const MODERATION_URL = 'https://api.openai.com/v1/moderations';
const TIMEOUT_MS = 6000;

/**
 * Screen a piece of text for kid-unsafe content.
 * @param {string} text   the user message or generation prompt to check
 * @param {string} apiKey OPENAI_API_KEY
 * @param {object} [options]
 * @param {boolean} [options.failClosed=false]  refuse when the text
 *   cannot be screened at all (see header). Default = historical
 *   fail-open behaviour.
 * @returns {Promise<{allowed: boolean, reason: string|null}>}
 */
export async function isAllowed(text, apiKey, { failClosed = false } = {}) {
  // Screening could not happen: fail OPEN by default (historical
  // policy), fail CLOSED when this request requires screening.
  const unavailable = (logLine) => {
    console.error(logLine);
    return failClosed
      ? { allowed: false, reason: 'moderation_unavailable' }
      : { allowed: true, reason: null };
  };

  // Nothing to check -> don't block, in either mode.
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { allowed: true, reason: null };
  }
  // No key to check with -> unscreened.
  if (!apiKey) {
    return unavailable('[moderation] OPENAI_API_KEY missing — failing OPEN (text not screened)');
  }

  try {
    const resp = await fetch(MODERATION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, input: text.slice(0, 8000) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
      // Provider-side failure -> fail OPEN but log loudly
      // (or fail CLOSED when screening is required).
      const body = await resp.text().catch(() => '');
      return unavailable(`[moderation] API ${resp.status} — failing OPEN. ${body.slice(0, 200)}`);
    }

    const data = await resp.json();
    const result = data?.results?.[0];
    if (!result) {
      return unavailable('[moderation] malformed response — failing OPEN');
    }

    if (result.flagged) {
      // Collect the tripped categories for the log / reason string.
      const cats = result.categories || {};
      const tripped = Object.keys(cats).filter((k) => cats[k]) || [];
      const reason = tripped.length ? tripped.join(', ') : 'flagged';
      console.warn(`[moderation] BLOCKED — categories: ${reason}`);
      return { allowed: false, reason };
    }

    return { allowed: true, reason: null };
  } catch (err) {
    // Network error / timeout -> fail OPEN, log it
    // (or fail CLOSED when screening is required).
    return unavailable(`[moderation] network error — failing OPEN: ${err?.message || err}`);
  }
}

// Standard speakable refusal so every endpoint sounds the same to the buddy.
export const SAFE_REFUSAL = "I can't make that — let's keep it friendly.";
