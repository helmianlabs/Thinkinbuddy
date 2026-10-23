// api/prime-agent.js — called when the page loads.
//
// Reads the user's persisted memories from Neon (`memory_items` via the shared
// pool in api/memory.js) and RETURNS the per-user system prompt to the CLIENT
// as JSON. The client applies it as a per-SESSION override on the ElevenLabs
// ConvAI widget (event.detail.config.overrides.agent.prompt.prompt) so each
// user's facts stay scoped to THEIR call only.
//
// 2026-06-02: PHASE 2 of the Neon migration. Was Vercel Blob → now Neon. Same
// {key,value} shape returned to buildSystemPrompt so the personality module
// doesn't change. Ranking: importance DESC, updated_at DESC, LIMIT 30.
// TODO: full cosine-similarity recall against a query embedding once we have
// a "what is the user talking about right now" hook on the client. Spec
// :130-172 / :355-468.
//
// ISOLATION FIX (2026-05-27): previously this endpoint PATCHed ONE GLOBAL
// agent's prompt on every page load, so the last user to load the page
// overwrote the shared prompt and every other live caller saw their facts
// (cross-user leak). We no longer mutate the shared agent at all — the prompt
// is returned to the client and applied per-session via the widget's
// `elevenlabs-convai:call` event (the SDK ships it as
// conversation_config_override on that session's socket only). This mirrors
// what script.js does with Conversation.startSession({ overrides }).
//
// NOTE: per-session prompt override requires "Overrides → System prompt" to be
// ENABLED in the ElevenLabs dashboard for this agent (Agent → Security tab).
// If that toggle is off, ElevenLabs ignores the override and falls back to the
// agent's saved prompt. This is a required one-time manual dashboard step.

import { buildSystemPrompt } from '../../lib/personality.js';
import { retrieveMemories } from './memory.js';
import { requireTenant, activeTenantId } from '../../lib/tenant.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Tenant wiring (store build — lib/tenant.js): this is the browser-
  // called identity anchor for a session. ENFORCED mode (SESSION_SECRET
  // set): the session token names the tenant, the prompt is built ONLY
  // from that tenant's memory_items (retrieveMemories tenantId filter),
  // and any body userId is ignored — a caller cannot prime another
  // tenant's prompt by naming them. COMPAT mode (no SESSION_SECRET,
  // today's live deployment): requireTenant returns the legacy tenant,
  // activeTenantId reports no scoping, and the body userId drives the
  // lookup exactly as before.
  const tenant = requireTenant(req, res);
  if (!tenant) return;
  const tenantId = activeTenantId(tenant);

  const buddyName = req.body?.buddyName || 'ThinkinBuddy';
  const userName = req.body?.userName || null;
  const userId = tenantId || req.body?.userId;
  // Optional conversational mode. Validated against VALID_MODES; unknown values
  // fall back to 'default'. Client passes the active mode via the request body.
  const VALID_MODES = ['default', 'spanish_tutor', 'feynman_module1'];
  const mode = VALID_MODES.includes(req.body?.mode) ? req.body.mode : 'default';

  // Isolation: a missing userId can no longer silently collapse onto 'troy'
  // and read someone else's prefix. The client always sends the real
  // per-user localStorage id (index.html initApp -> user.userId).
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ ok: false, error: 'userId required' });
  }

  // Optional retrieval inputs (all backward-compatible — absent = old behavior):
  //   query           — if the client knows "what the user is talking about",
  //                      it triggers VECTOR-FIRST recall (memory.js retrieveMemories).
  //                      Absent → non-circular boot rank (importance/confidence/recency).
  //   projectSlug/taskId — widen scope to project:<slug> / task:<id> (spec :141-143).
  // The HTTP contract (response shape, required userId) is unchanged.
  const query = typeof req.body?.query === 'string' ? req.body.query : undefined;
  const projectSlug = typeof req.body?.projectSlug === 'string' ? req.body.projectSlug : null;
  const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : null;

  const scopes = ['semantic'];
  if (projectSlug) scopes.push(`project:${projectSlug}`);
  if (taskId) scopes.push(`task:${taskId}`);

  let facts = [];
  try {
    facts = await retrieveMemories(userId, { limit: 30, query, scopes, tenantId });
  } catch (err) {
    console.error('[prime-agent] retrieveMemories failed:', err?.message || err);
    facts = [];
  }

  // ElevenLabs widget path: it has REAL tool calls registered on the agent,
  // so we don't need the action-tag fallback here. Tools block stays.
  const prompt = buildSystemPrompt({
    buddyName,
    userName,
    memories: facts,
    includeToolsBlock: true,
    includeActionTags: false,
    mode,
  });

  // Return the per-user prompt to the client. The client sets it on the
  // widget's per-session override (overrides.agent.prompt.prompt) so user A's
  // facts never touch the shared agent and never reach user B's session.
  // We do NOT PATCH the global agent anymore.
  //
  // TENANT MAPPING for the rest of the session (hosted mode): the client
  // must set the ElevenLabs widget's `user_id` dynamic variable to the
  // tenantId returned here. That value is what the agent's tool calls
  // (save_memory, recall_memory), the per-turn capture, and the post-call
  // webhook's session metadata carry back to this server, and in enforced
  // mode each of those handlers resolves the tenant from it (see
  // lib/tenant.js resolveHandlerTenant and api/conversation-webhook.js).
  // In compat mode tenantId is null and the widget keeps sending its
  // legacy userId, unchanged.
  return res.status(200).json({ ok: true, prompt, memoryCount: facts.length, buddyName, userId, tenantId });
}
