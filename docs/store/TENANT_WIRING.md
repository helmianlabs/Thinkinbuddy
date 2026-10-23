# Tenant wiring — NEXT bite checklist (no handler edits in bite 1)

Bite 1 (this branch) landed only the scaffold: `sql/store/001_tenants.sql`,
`sql/store/002_tenant_columns.sql`, `lib/tenant.js`
(`signSession` / `verifySession` / `resolveTenant` / `requireTenant` /
`scopeToTenant`), and `test/tenant.test.mjs`.

This file is the checklist for the wiring bite: every place that today
trusts a client-supplied or hardcoded identity and must instead take the
tenant from `requireTenant(req, res)` (session token, `SESSION_SECRET`)
and filter/write by `tenant_id`. Source of the list: bite 0 audit §2 gap 10,
verified against the repo at `344e2bc8`.

**The pattern for every item below** (unless noted):
1. `const tenant = requireTenant(req, res); if (!tenant) return;`
2. Replace the old `user_id` value with `tenant.tenantId`.
3. Every SELECT gains `AND tenant_id = $n`; every INSERT writes `tenant_id`.
4. Delete the fallback/default identity entirely — no default tenant in
   handler code, ever. A missing session is a 401, not the legacy tenant.

## Identity source itself

- [ ] **`index.html` — `genUserId()` (L1003-1008)**
  Returns the hardcoded string `'troy'` for every user on every device
  (also has a random localStorage path elsewhere — identity is inconsistent
  across surfaces). Replace with: the signed-in account's session token,
  stored after login, sent as `Authorization: Bearer <token>` via the
  existing `apiFetch` wrapper (the same wrapper that already attaches the
  `X-User-Key-*` headers for `lib/userKeys.js`).

- [ ] **`lib/security.js` — the "THIS IS NOT AUTHENTICATION" block (L152-164 area)**
  `requireBrowserFetch` / CORS / Sec-Fetch gating stays as an abuse-cost
  layer, but it stops being the identity story. Update the comment to point
  at `lib/tenant.js`; the gates no longer stand in for auth.

## Handlers that hardcode or default the identity

- [ ] **`api/conversation-webhook.js` (L256)**
  ElevenLabs post-call webhook inserts `user_id 'troy'` into the
  conversation tables. This is a server-to-server webhook (HMAC-verified,
  keep that gate) — it has no user session. Replacement: resolve the tenant
  from the ElevenLabs conversation's session metadata (the `user_id`
  dynamic variable the widget already sends must carry the tenant id, set
  at session start by `prime-agent`), look the tenant up, and write
  `tenant_id` on `conversation_sessions` / `conversation_turns`. Reject
  (and log) a webhook whose session maps to no tenant — never default.

- [ ] **`server/handlers/alarm.js` (L82, L210, L253)**
  Defaults `userId` to `'troy'`, no auth, wildcard CORS. Replacement:
  `requireTenant` for the browser-called paths; ElevenLabs tool calls to
  this handler resolve the tenant the same way as the webhook item above.
  Alarms storage keys/rows take `tenant_id`. (Timezone is also hardcoded
  `America/Boise` at L168-182 — should come from `profiles` later; noted,
  not this bite.)

- [ ] **`server/handlers/recall-memory.js` (L51-57)**
  The handler's own comment warns it "would hand a stranger Troy's
  memories on request." Replacement: tenant from the tool-call session
  resolution (as webhook above); `memory_items` queries filter
  `tenant_id = tenant`; the leak-warning comment comes out when the filter
  lands and a two-tenant test covers this handler.

- [ ] **`server/handlers/conversation-history.js` (L48-66, gate at L158)**
  Carries the same stranger warning; currently secret-gated only.
  Replacement: keep the webhook-secret gate AND scope the export to one
  `tenant_id` (the tenant the request is for, from the session/token the
  caller presents) — the secret alone must no longer unlock everyone's
  transcripts.

- [ ] **`server/handlers/conversation-turn.js`**
  Live per-turn capture, no auth gate (CORS `*` at L42 per audit).
  Replacement: tenant resolved from the conversation's session (as webhook
  above) and written on every `conversation_turns` row.

- [ ] **`server/handlers/prime-agent.js` (L90-100)**
  Already rejects a missing `userId` — the closest thing to a gate today.
  Replacement: `requireTenant`; the per-user prompt is built only from
  `memory_items` rows with `tenant_id = tenant`; the `user_id` the widget
  sends onward (webhook resolution key) becomes the tenant id.

- [ ] **`server/handlers/memory.js` + `server/handlers/memory-admin.js`**
  Core memory store (Neon + pgvector). Replacement: `requireTenant` on the
  browser paths; every read/write on `memory_items` filters/writes
  `tenant_id`. `memory-admin.js` keeps its hard webhook-secret gate (L184)
  for operator actions, but per-user CRUD/export scopes to a named
  `tenant_id` instead of the whole table.

- [ ] **`server/handlers/extract-memories.js`**
  Post-call memory extraction with no caller auth gate. Replacement:
  tenant from session resolution; extracted candidates are saved with that
  `tenant_id` (the PII filter already in this handler stays).

- [ ] **`server/handlers/media-gallery.js`, `latest-image.js`, `latest-video.js`**
  Media lookups with no gate; `userId` defaults to `'anonymous'`.
  Replacement: `requireTenant`; media rows in `memory_items` are filtered
  by `tenant_id`; the `'anonymous'` default is deleted. (Public-Blob media
  privacy is a separate audit fix item — this bite only scopes the lookup.)

- [ ] **`server/handlers/task.js`**
  `save_task_for_clyde` tool: no auth, no user scoping, GET lists all
  tasks. Replacement: tenant from session resolution; tasks are written
  and listed per `tenant_id`. (Storage is Blob JSON today — scoping key
  prefix by tenant id is acceptable for this bite.)

- [ ] **Actionable handlers (`server/handlers/actionable*.js`, `lib/actionable/`)**
  Actionable has its own auth (`lib/actionable/http.js`) and its tables now
  carry `tenant_id` (002). Replacement: map Actionable's authenticated
  user to a tenant at its auth boundary and thread `tenant_id` through
  `lib/actionable/db.js` queries. Do this LAST in the wiring bite, and only
  if Actionable is confirmed in store scope (bite 0 audit, cleanup item 3).

## Explicitly out of scope for the wiring bite

- `server/handlers/mcp.js`, `relay-http.js`, `relay-proxy.js` — the personal
  MCP Memory Vault + Helmian relay run on a **separate** database
  (`NEON_CLAUDE_MEMORY_URL`) and are Troy's personal infrastructure, not
  store user data. They get no tenant wiring; their fate is the audit's
  cleanup decision, not this checklist.
- Metering (usage_ledger writes), entitlement checks, and login/session
  issuance UI — bites 2 and 3. This checklist only threads identity that
  bite 1's scaffold can already verify.

## Wiring-bite acceptance test

- [ ] Two tenants, interleaved data in `memory_items`,
  `conversation_sessions`, `conversation_turns`: every handler above,
  called with tenant A's token, returns zero of tenant B's rows — the
  handler-level version of `scopeToTenant`'s test in `test/tenant.test.mjs`.
- [ ] No handler in the list above contains the string `'troy'` or
  `'anonymous'` as an identity default, and no identity fallback remains.
