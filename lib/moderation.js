// lib/moderation.js — kid-safe content gate using OpenAI's FREE moderation API.
//
// One export: isAllowed(text, apiKey) -> { allowed: bool, reason: string|null }
//
// Used by the generation endpoints (image / image-imagen / image-flux /
// video-sora / video-runway) and chat.js to screen user input and any
// prompt we're about to send to a provider, BEFORE the provider call.
//
// FAIL POLICY (deliberate, for a kids app):
//   - Flagged result            -> FAIL CLOSED (allowed:false). We refuse.
//   - Network / API error        -> FAIL OPEN (allowed:true) + console.error.
//     Rationale: a transient OpenAI hiccup must not brick the buddy for every
//     kid mid-sentence. Layer 1 (the immutable system prompt) and Layer 3
//     (safe-browse denylist) are still in force, so fail-open here is the
//     least-bad failure mode. The miss is logged so it's visible.
//   - No apiKey / empty text     -> FAIL OPEN (nothing to check / can't check).
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
 * @returns {Promise<{allowed: boolean, reason: string|null}>}
 */
export async function isAllowed(text, apiKey) {
  // Nothing to check, or no key to check with -> don't block.
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { allowed: true, reason: null };
  }
  if (!apiKey) {
    console.error('[moderation] OPENAI_API_KEY missing — failing OPEN (text not screened)');
    return { allowed: true, reason: null };
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
      // Provider-side failure -> fail OPEN but log loudly.
      const body = await resp.text().catch(() => '');
      console.error(`[moderation] API ${resp.status} — failing OPEN. ${body.slice(0, 200)}`);
      return { allowed: true, reason: null };
    }

    const data = await resp.json();
    const result = data?.results?.[0];
    if (!result) {
      console.error('[moderation] malformed response — failing OPEN');
      return { allowed: true, reason: null };
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
    // Network error / timeout -> fail OPEN, log it.
    console.error('[moderation] network error — failing OPEN:', err?.message || err);
    return { allowed: true, reason: null };
  }
}

// Standard speakable refusal so every endpoint sounds the same to the buddy.
export const SAFE_REFUSAL = "I can't make that — let's keep it friendly.";
