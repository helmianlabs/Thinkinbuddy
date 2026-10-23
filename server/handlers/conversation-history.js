// api/conversation-history.js — READ side of the conversation log.
//
// WHY THIS EXISTS: conversation_sessions and conversation_turns were
// write-only. Two writers put rows in — api/conversation-turn.js:39,47 (live,
// per turn) and api/conversation-webhook.js:133,143 (post-call reconcile) —
// and NOTHING ever read them back. The only SELECT anywhere in the repo was
// conversation-webhook.js:124, an id lookup that never returns content. So
// Troy's conversations were being durably saved and there was no way, from any
// surface, to get one out again. This is that way.
//
// READ-ONLY BY CONSTRUCTION: GET only, SELECT only. No INSERT/UPDATE/DELETE
// path exists in this file. That is deliberate — see the auth note below for
// why a mutating sibling would be dangerous here.
//
// ─── ROUTES ─────────────────────────────────────────────────────────────────
//   GET /api/conversation-history?userId=U
//         [&limit=20&offset=0]        → newest sessions first, turns inlined
//   GET /api/conversation-history?userId=U&sessionId=S   → one session
//   GET /api/conversation-history?userId=U&includeRaw=1  → include turns[].raw
//
// ─── AUTH — READ THIS BEFORE MAKING IT BROWSER-CALLABLE ─────────────────────
// Gated with requireWebhookSecret: server-to-server only, closed by default
// (lib/security.js:78-84 returns 503 when WEBHOOK_SECRET is unset).
//
// UPDATE (store wiring bite — lib/tenant.js): the app now HAS a caller
// identity in hosted mode. When SESSION_SECRET is set (enforced mode),
// the export below is scoped to ONE tenant_id in addition to the
// webhook-secret gate: the tenant is resolved from the caller's session
// token, or — for this server-to-server route — from the userId value
// itself, which in hosted mode IS the tenant id (the widget's `user_id`
// dynamic variable carries it; see prime-agent.js). An enforced-mode
// request whose tenant cannot be resolved is rejected; the secret alone
// no longer unlocks everyone's transcripts. When SESSION_SECRET is NOT
// set (compat mode — today's live deployment), the original behavior
// stands, and it is still NOT scoped "a caller may only read their own
// sessions": genUserId() (index.html:1003-1008) returns the hardcoded
// string 'troy' for every user on every device, so `userId` is a
// guessable constant, not a credential, and this route stays
// server-to-server only behind the webhook secret. Transcripts are far
// more sensitive than the short facts memory-admin exposes, so this
// route does not repeat that pattern in either mode.
//
// CONSEQUENCE FOR THE EXPORT BUTTON: a browser cannot call this route without
// shipping WEBHOOK_SECRET into the client bundle, which would stop it being a
// secret. Making it safely browser-callable needs a real per-user credential.
// The minimum schema for that is written up in docs/TOOL_AUTH_ROLLOUT.md under
// "Proposed schema"; it is NOT applied, NOT executed, and is Troy's call
// (Tier B — writing it as a .sql migration was blocked by the autonomy hook,
// which is correct).
//
// ─── TWO WRITERS, ONE TIMELINE ──────────────────────────────────────────────
// turns[].source is 'live' (conversation-turn.js:48) or 'post_call_webhook'
// (conversation-webhook.js:145, which upserts over the live row on conflict).
// sessions[].source is 'elevenlabs_widget' (the default in
// setup-conversation-log-db.mjs:63) or 'post_call_webhook_only' when the
// webhook created the session because client capture never fired at all
// (conversation-webhook.js:133-137). Both are surfaced rather than flattened,
// so an export can tell a reconciled transcript from a live-only one.

import { getPool } from './memory.js';
import { requireWebhookSecret } from '../../lib/security.js';
import { resolveHandlerTenant } from '../../lib/tenant.js';

const MAX_LIMIT = 100;

function toIso(v) {
  return v?.toISOString?.() || v || null;
}

// Readable speaker label for the convenience transcript. Roles written by the
// two producers are 'user' and 'agent' (conversation-turn.js:744); the webhook
// path can also yield 'assistant'/'ai' depending on ElevenLabs' payload shape,
// so anything not 'user' that looks like the bot maps to the buddy name. An
// unrecognised role is passed through verbatim rather than guessed at.
function speakerLabel(role, buddyName) {
  const r = String(role || '').toLowerCase();
  if (r === 'user') return 'User';
  if (r === 'agent' || r === 'assistant' || r === 'ai') return buddyName;
  return role || 'unknown';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Webhook-Secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Gate BEFORE touching the database or echoing anything about the userId,
  // so an unauthorized caller cannot use response shape or timing to learn
  // whether a given userId has sessions.
  if (!requireWebhookSecret(req, res)) return;

  const userId = req.query?.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  // Tenant scoping (enforced mode only — see the AUTH note at the top):
  // tenantId non-null scopes BOTH selects below; null (compat) leaves
  // the original user_id-only queries untouched.
  const resolvedTenant = resolveHandlerTenant(req, userId);
  if (!resolvedTenant.ok) {
    return res.status(400).json({ error: 'tenant identity required (session token or tenant user_id)' });
  }
  const tenantId = resolvedTenant.tenantId;

  // conversation_sessions.id is UUID (setup-conversation-log-db.mjs:54). A
  // non-UUID value reaches Postgres and throws 22P02, which this file's catch
  // would surface as a 500 — the wrong signal for what is a caller mistake.
  const sessionId = req.query?.sessionId || null;
  if (sessionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    return res.status(400).json({ error: 'sessionId must be a UUID' });
  }
  const includeRaw = req.query?.includeRaw === '1';
  const buddyName = req.query?.buddyName || 'ThinkinBuddy';

  const rawLimit = Number.parseInt(req.query?.limit ?? '20', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : 20;
  const rawOffset = Number.parseInt(req.query?.offset ?? '0', 10);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  try {
    const pool = getPool();

    // 1. Sessions for this user, newest first. Asking for limit+1 is how
    //    hasMore is derived without a second COUNT over the same predicate.
    const sessionParams = [userId, limit + 1, offset];
    let tenantParamSql = '';
    if (tenantId) { sessionParams.push(tenantId); tenantParamSql = `AND tenant_id = $${sessionParams.length}`; }
    if (sessionId) sessionParams.push(sessionId);
    const sessionSql = `
      SELECT id, user_id, conversation_id, agent_id, started_at, ended_at,
             end_reason, turn_count, reconciled, source, summary
        FROM conversation_sessions
       WHERE user_id = $1
         ${tenantParamSql}
         ${sessionId ? `AND id = $${sessionParams.length}` : ''}
       ORDER BY started_at DESC
       LIMIT $2 OFFSET $3`;
    const { rows: sessionRows } = await pool.query(sessionSql, sessionParams);

    const hasMore = sessionRows.length > limit;
    const sessions = hasMore ? sessionRows.slice(0, limit) : sessionRows;

    if (sessions.length === 0) {
      return res.status(200).json({
        userId, sessionCount: 0, totalTurns: 0, sessions: [],
        pagination: { limit, offset, returned: 0, hasMore: false },
      });
    }

    // 2. Every turn for those sessions in ONE query — not one query per
    //    session. ORDER BY turn_index is the authoritative ordering: it is the
    //    unique key both writers upsert on (conversation-turn.js:49,
    //    conversation-webhook.js:146), so it survives retries and reconcile
    //    without duplicating or reordering a turn. created_at would NOT be
    //    safe here: a webhook backfill writes later than the live row it
    //    replaces, so sorting by time would scramble a reconciled transcript.
    const ids = sessions.map((s) => s.id);
    // Turns are scoped twice over in enforced mode: by the (already
    // tenant-filtered) session ids AND by the turns' own tenant_id
    // column (sql/store/002 backfills it from the session), so a turn
    // written before the session was stamped still cannot leak across.
    const { rows: turnRows } = await pool.query(
      `SELECT session_id, turn_index, role, content, source, created_at
              ${includeRaw ? ', raw' : ''}
         FROM conversation_turns
        WHERE session_id = ANY($1::uuid[])
          ${tenantId ? 'AND tenant_id = $2' : ''}
        ORDER BY session_id, turn_index ASC`,
      tenantId ? [ids, tenantId] : [ids]
    );

    const bySession = new Map(ids.map((id) => [id, []]));
    for (const t of turnRows) {
      const turn = {
        turnIndex: t.turn_index,
        role: t.role,
        content: t.content,
        source: t.source,
        createdAt: toIso(t.created_at),
      };
      if (includeRaw) turn.raw = t.raw;
      bySession.get(t.session_id)?.push(turn);
    }

    let totalTurns = 0;
    const shaped = sessions.map((s) => {
      const turns = bySession.get(s.id) || [];
      totalTurns += turns.length;
      return {
        sessionId: s.id,
        conversationId: s.conversation_id,
        agentId: s.agent_id,
        startedAt: toIso(s.started_at),
        endedAt: toIso(s.ended_at),
        endReason: s.end_reason,
        // turn_count is the stored counter both writers maintain; turns.length
        // is what actually came back. Reporting both makes a divergence
        // visible instead of silently trusting the counter.
        turnCount: s.turn_count,
        turnsReturned: turns.length,
        reconciled: s.reconciled,
        source: s.source,
        summary: s.summary,
        turns,
        // Convenience rendering so an export can write a file without
        // reformatting. Derived from `turns`, never stored.
        transcript: turns
          .map((t) => `${speakerLabel(t.role, buddyName)}: ${t.content ?? ''}`)
          .join('\n\n'),
      };
    });

    return res.status(200).json({
      userId,
      sessionCount: shaped.length,
      totalTurns,
      sessions: shaped,
      pagination: { limit, offset, returned: shaped.length, hasMore },
    });
  } catch (err) {
    console.error('[conversation-history] failed:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'history read failed' });
  }
}
