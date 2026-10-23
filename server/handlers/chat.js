// api/chat.js — text-chat fallback used by desktop.html.
//
// Personality comes from lib/personality.js — single source of truth.
// This path is text-only (no ElevenLabs voice, no real webhook tools), so
// we expose the [ACTION:*] tag protocol instead of the tool block.

import { buildSystemPrompt } from '../../lib/personality.js';
import { applyBrowserCors, requireBrowserFetch } from '../../lib/security.js';
import { isAllowed, SAFE_REFUSAL } from '../../lib/moderation.js';
import { getKey } from '../../lib/userKeys.js';
import { safetyDecision, safetyInputsFromRequest } from '../../lib/safety.js';
import { completeText, hasTextLlm, keyForProvider, preferredBrain } from '../../lib/llm.js';
import { resolveTenant, activeTenantId } from '../../lib/tenant.js';
import { costFor, meterGate, denyMetering, recordMetered, getUsageDb } from '../../lib/usage.js';
import { randomUUID } from 'node:crypto';

// Payload ceilings. A single request cannot be made expensive: input tokens are
// what cost money here (max_tokens caps only the OUTPUT at 400), so an
// unbounded messages array is the cheap way to run up a bill on someone else's
// key. These are far above any real conversation from this UI.
const MAX_MESSAGES = 100;
const MAX_TOTAL_CHARS = 100_000; // ~25k tokens of input

function totalChars(messages) {
  let n = 0;
  for (const m of messages) {
    const c = m?.content;
    if (typeof c === 'string') n += c.length;
    else if (Array.isArray(c)) for (const b of c) n += typeof b === 'string' ? b.length : (b?.text?.length || 0);
    if (n > MAX_TOTAL_CHARS) return n; // stop counting once over
  }
  return n;
}

export default async function handler(req, res) {
  // NOT AUTHENTICATION — see lib/security.js:requireBrowserFetch. This makes
  // the endpoint cost more to abuse; it does not make it safe. A caller who
  // sets Origin plus the three Sec-Fetch-* headers still gets in, and there is
  // no way to stop that without a real user credential, which this app has
  // none of. Do not mark /api/chat "secured" on the strength of this.
  //
  // Preflight must still answer on origin alone: a browser sends OPTIONS
  // WITHOUT Sec-Fetch-Mode: cors on the actual request semantics, and failing
  // the preflight would block the very browsers this is meant to keep working.
  const originOk = applyBrowserCors(req, res);
  if (req.method === 'OPTIONS') {
    return res.status(originOk ? 200 : 403).end();
  }
  if (!requireBrowserFetch(req, res)) return; // writes 403 itself
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, userContext, mode: rawMode } = req.body || {};
  const VALID_MODES = ['default', 'spanish_tutor', 'feynman_module1'];
  const mode = VALID_MODES.includes(rawMode) ? rawMode : 'default';
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  // Cap BEFORE the moderation call and the Anthropic call — both cost money.
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages must be an array' });
  }
  if (messages.length > MAX_MESSAGES) {
    return res.status(413).json({ error: `too many messages (max ${MAX_MESSAGES})` });
  }
  if (totalChars(messages) > MAX_TOTAL_CHARS) {
    return res.status(413).json({ error: `conversation too large (max ${MAX_TOTAL_CHARS} characters)` });
  }

  if (!hasTextLlm(req)) return res.status(500).json({ reply: 'No LLM key. Use Free Gemini, or add a key under Settings → Your AI.' });

  // Kid-safe gate: moderate the latest user message BEFORE calling Claude.
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastUserText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : Array.isArray(lastUser?.content)
      ? lastUser.content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join(' ')
      : '';
  // Safety posture for this request (parent safety mode / minor age
  // band, read from the request's existing plumbing — lib/safety.js).
  // When it applies, moderation fails CLOSED and the kid safety core
  // joins the system prompt: unscreened never reaches the LLM.
  const safetyIn = safetyInputsFromRequest(req);
  const safety = safetyDecision(safetyIn);
  const mod = await isAllowed(lastUserText, getKey(req, 'OPENAI_API_KEY'), { failClosed: safety.failClosed });
  if (!mod.allowed) {
    console.warn('[chat] user message blocked by moderation:', mod.reason);
    return res.status(200).json({ reply: "Let's keep it friendly — I'm not going there. What else is on your mind?" });
  }

  // Usage metering (hosted model, lib/usage.js): enforced mode + a
  // server (env) key for the chosen brain -> the tenant's monthly
  // bucket must cover this message BEFORE the LLM call (402 when
  // exhausted). If the request runs on the user's own key for their
  // chosen brain (BYO), or in compat mode, meterGate skips metering
  // entirely and makes no DB call.
  const chatTenantId = activeTenantId(resolveTenant(req));
  const chatBrain = preferredBrain(req);
  const chatReqId = randomUUID();
  const chatEst = costFor('chat');
  const chatGate = await meterGate({
    db: getUsageDb,
    tenantId: chatTenantId,
    keySource: keyForProvider(req, chatBrain).source,
    estCredits: chatEst,
  });
  if (!chatGate.allowed) return denyMetering(res, chatGate);

  const systemPrompt = buildSystemPrompt({
    buddyName: userContext?.buddyName,
    userName: userContext?.name,
    memories: userContext?.memories || [],
    includeToolsBlock: false,   // no webhook tools on this surface
    includeActionTags: true,    // text path uses ACTION tags as its "tools"
    mode,
    safetyMode: safetyIn.safetyMode,
    ageBand: safetyIn.ageBand,
  });

  try {
    const reply = (await completeText({
      req,
      maxTokens: 400,
      system: systemPrompt,
      user: messages.map((m) => {
        const role = m.role === 'assistant' ? 'Buddy' : 'User';
        const c = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join(' ')
            : '';
        return `${role}: ${c}`;
      }).join('\n\n'),
    })) || 'No response.';

    // The provider call succeeded — the cost is incurred even if the
    // output gate below replaces the reply, so record it now.
    await recordMetered(chatGate, getUsageDb, {
      tenantId: chatTenantId, provider: chatBrain, action: 'chat',
      units: 1, credits: chatEst, requestId: chatReqId,
    });

    // Output gate (audit §2 gap 4): screen the buddy's reply BEFORE it
    // leaves — input-only moderation let anything the model produced
    // through. A flagged reply is replaced with the standard refusal:
    // never returned, never scanned for ACTION tags.
    const outMod = await isAllowed(reply, getKey(req, 'OPENAI_API_KEY'), { failClosed: safety.failClosed });
    if (!outMod.allowed) {
      console.warn('[chat] assistant reply blocked by moderation:', outMod.reason);
      return res.status(200).json({ reply: SAFE_REFUSAL });
    }

    // If the buddy emitted [ACTION:SAVE_TASK:x], persist it silently.
    const taskMatch = reply.match(/\[ACTION:SAVE_TASK:([^\]]+)\]/);
    if (taskMatch) {
      try {
        const { put } = await import('@vercel/blob');
        const id = Date.now();
        await put(`tasks/${id}.json`, JSON.stringify({
          id,
          task: taskMatch[1],
          project: 'general',
          userId: userContext?.userId || 'anonymous',
          created: new Date().toISOString(),
        }), { access: 'public', contentType: 'application/json' });
      } catch (e) { /* ignore blob errors */ }
    }

    return res.status(200).json({ reply });
  } catch (e) {
    console.error('[chat] error:', e?.message || e);
    return res.status(500).json({ reply: 'Something went wrong. Try again.' });
  }
}
