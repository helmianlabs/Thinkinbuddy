// api/recall-memory.js — LIVE mid-conversation memory recall tool.
//
// Registered on the ElevenLabs agent as a new `recall_memory` webhook tool
// (see scripts/update-agent-config.mjs) so the agent can look something up
// from Neon DURING a call, not just from the ~30 facts pre-loaded into the
// system prompt at boot (api/prime-agent.js). Uses the same vector-search
// retrieveMemories() the boot path uses, just with a live query.
//
// userId is bound to the {{user_id}} dynamic variable (same mechanism
// index.html already uses for save_memory -- see conversation_config
// dynamic_variables wiring in index.html's elevenlabs-convai:call handler).
//
// Body: { userId, query }
// Response: kept intentionally simple/flat -- ElevenLabs tools have no
// response_body_schema configured, so whatever JSON comes back is handed to
// the LLM as raw context for it to speak naturally, not parsed structurally.

import { retrieveMemories } from './memory.js';
import { requireToolAuth } from '../../lib/security.js';
import { resolveHandlerTenant } from '../../lib/tenant.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Two costs on every call: an OpenAI embedding (memory.js:115) and a read of
  // whatever this userId has stored. The pre-wiring warning that stood here
  // ("this endpoint would hand a stranger Troy's memories on request") is
  // addressed by the tenant resolution below IN ENFORCED MODE: with
  // SESSION_SECRET set, the caller must present a session token or the
  // tenant id itself as userId (the ElevenLabs `user_id` dynamic variable
  // carries the tenant id in hosted mode), and retrieveMemories filters
  // memory_items by that tenant_id — another tenant's rows cannot come
  // back. In COMPAT mode (no SESSION_SECRET — today's live deployment)
  // behavior is unchanged: userId keys the lookup exactly as before.
  //
  // Tool-auth gate NO-OP UNTIL ENFORCE_TOOL_AUTH=1 — see
  // lib/security.js:requireToolAuth. (Independent of tenant enforcement.)
  if (!requireToolAuth(req, res)) return;

  const userId = req.body?.userId;
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!query) return res.status(400).json({ error: 'query required' });

  const resolvedTenant = resolveHandlerTenant(req, userId);
  if (!resolvedTenant.ok) {
    return res.status(400).json({ error: 'tenant identity required (session token or tenant user_id)' });
  }

  try {
    const facts = await retrieveMemories(userId, { limit: 5, query, tenantId: resolvedTenant.tenantId });
    if (!facts.length) {
      return res.status(200).json({ found: false, summary: "I don't have anything saved about that." });
    }
    const summary = facts.map((f) => f.value).join(' ');
    return res.status(200).json({ found: true, count: facts.length, facts, summary });
  } catch (err) {
    console.error('[recall-memory] failed:', err?.message || err);
    return res.status(200).json({ found: false, summary: "I couldn't check my memory just now.", error: err?.message });
  }
}
