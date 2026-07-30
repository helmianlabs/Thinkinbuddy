# Closing the open spending endpoints — two-step rollout

**Status: STEP 1 NOT DONE. The hole is still open.** The code is in place and
deployed-safe, but `/api/search`, `/api/browse` and `/api/recall-memory` remain
callable by anyone until both steps below are finished. Do not record this as
fixed until step 2.

## What was open, and how it was proven

Probed live against `https://jarvis-troy.vercel.app` on 2026-07-30 with empty
bodies, which fail parameter validation before spending anything:

| Endpoint | Result | What it spends |
|---|---|---|
| `POST /api/search {}` | `400 {"error":"query required"}` | `OPENAI_API_KEY` (`search.js:36`) then `ANTHROPIC_API_KEY` (`search.js:42`) |
| `POST /api/browse {}` | `400 {"error":"url required"}` | `OPENAI_API_KEY` (`browse.js:74`) then `ANTHROPIC_API_KEY` (`browse.js:80`) |
| `POST /api/recall-memory {}` | `400 {"error":"userId required"}` | OpenAI embedding (`memory.js:115`) + reads stored memories |

Reaching parameter validation means nothing stood in front of them. A 400 is
not a gate.

`/api/chat` looked gated but is not: with no `Origin` header it returns 403,
and with `-H 'Origin: https://jarvis-troy.vercel.app'` it returns
`400 {"error":"messages required"}`. **CORS is not authentication** — the file
that implements it says so at `lib/security.js:8-13`. A browser honors it;
`curl` sets the header and walks in.

## Why this is staged instead of just closed

`/api/search`, `/api/browse` and `/api/recall-memory` are called **only** by the
live ElevenLabs agent's tool webhooks (`agent_4401kqcb0w2dey28c69zhchv7ayn`).
Verified: no other caller exists in the repo, and the agent's registered tools
point at exactly these URLs.

Those three tools currently send **no headers at all** (verified live — see the
table below). Hard-gating the endpoints would mean the next deploy silently
breaks the voice assistant mid-call: `search_web`, `browse_url` and
`recall_memory` would all start returning 401. So `requireToolAuth`
(`lib/security.js`) defaults **off**, and closing the hole is step 2.

## STEP 1 — add the header to three tools

The pattern already works on this agent. Five tools carry it today and are
calling successfully, so this is a copy of a known-good config, not a new idea:

| Tool | Tool ID | Sends `X-Webhook-Secret` today |
|---|---|---|
| `generate_image` | `tool_9001kt5rne5tf1v9449ghmvtd8tz` | YES — 64 chars |
| `generate_image_flux` | `tool_1201kt61mgjzfcfsrq9efnx3hjvh` | YES |
| `generate_image_imagen` | `tool_3701kt61mgjyfkzvymzs5p2ywn2e` | YES |
| `generate_video_sora` | `tool_8101kt61mgjwfhssdj9q6zek7q5w` | YES |
| `generate_video_runway` | `tool_3901kt61mgjxe0xaeae836s1gxg5` | YES |
| **`search_web`** | **`tool_7701krkqhd7we908q6kv52mpvv96`** | **no — add it** |
| **`browse_url`** | **`tool_0601krkqhd7tfe68whs7cjq1nt86`** | **no — add it** |
| **`recall_memory`** | **`tool_1501ky0a9qqtezfba6d7036bce16`** | **no — add it** |

The field is `tool_config.api_schema.request_headers`, a map of header name to
value. Set `X-Webhook-Secret` to the same value as the Vercel `WEBHOOK_SECRET`
env var — the identical value the five working tools already carry.

### TRAP: use the IDs above, not the names

The workspace contains **duplicate tools with the same name**, and only one copy
of each is attached to the agent. Counts as of 2026-07-30:

```
search_web: 3 copies      browse_url: 2 copies      generate_image: 2 copies
save_memory: 2 copies     save_task_for_clyde: 4 copies
```

Editing a duplicate changes nothing and looks like it worked. Match on tool ID.

`scripts/update-agent-config.mjs` is the working example of PATCHing a tool
through this API, including the constraint it discovered the hard way: the agent
rejects a PATCH carrying both `tools` and `tool_ids`.

### Verify step 1 before step 2

Make a real voice call and use `search_web`, `browse_url` and `recall_memory`.
All three must still work — the endpoints are still open at this point, so a
failure here is a config error, not the gate.

## STEP 2 — flip the flag. This is the step that closes the hole.

Set in Vercel (all environments), then redeploy:

```
ENFORCE_TOOL_AUTH=1
```

Confirm `WEBHOOK_SECRET` is set in the same environment first. If it is missing,
`requireWebhookSecret` returns 503 for every caller (`lib/security.js:81-84`) and
the three tools stop working.

### Verify step 2

```
curl -s -X POST https://jarvis-troy.vercel.app/api/search \
  -H 'Content-Type: application/json' -d '{"query":"test"}'
```
Expect `401 {"result":"Unauthorized"}`. Anything else means the hole is open.
Then make one more voice call and confirm all three tools still work.

## Still open after both steps — needs a decision, not a config change

These are called **by the browser**, so a shared secret cannot protect them: the
secret would have to ship inside the client bundle, where it is not a secret.

| Endpoint | Caller | Spends |
|---|---|---|
| `/api/chat` | `desktop.html` | `ANTHROPIC_API_KEY` |
| `/api/memory` (POST) | `index.html` **and** the `save_memory` tool | OpenAI embeddings |
| `/api/conversation-turn` | `index.html` | DB writes only |

Closing these needs one of: real user authentication (none exists — see below),
or per-IP rate limiting, which on Vercel serverless needs shared state and
therefore a schema change.

## The root cause under all of it

`genUserId()` at `index.html:1003-1008` returns the hardcoded string `'troy'`
for every user on every device. `conversation-webhook.js:135` hardcodes `'troy'`
too. There is no session, no token and no login anywhere in the app. So `userId`
is a guessable constant rather than a credential — which is why
`GET /api/memory?userId=troy` returned Troy's stored facts over plain HTTP with
no authentication at all.

Until that changes, every `userId`-keyed endpoint is world-readable by design.

## Proposed schema — NOT APPLIED, NOT EXECUTED, Troy's call

This is the minimum that would let the export button call
`/api/conversation-history` from the browser safely. It is written here as
documentation on purpose: creating it as a `.sql` migration was blocked by the
autonomy boundary hook as a Tier B action, which is correct — a schema change
needs Troy, not an agent. Nothing reads these tables, so applying it changes no
behaviour on its own.

```sql
CREATE TABLE IF NOT EXISTS user_access_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL,
  -- SHA-256 of the token. Plaintext is returned to the client once, at mint
  -- time, and is never stored or logged.
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_access_tokens_user
  ON user_access_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_access_tokens_hash
  ON user_access_tokens (token_hash);
```

The code change that would follow, also not written:

1. Mint on first load — 32 random bytes, hex returned to the client once, only
   `sha256(hex)` stored. Client keeps it beside `thinkinbuddy_user_id`
   (`index.html:1828`).
2. Client sends `Authorization: Bearer <token>`.
3. `api/conversation-history.js` accepts **either** that bearer token, resolved
   via `token_hash` and checked against the requested `userId`, **or** the
   existing `WEBHOOK_SECRET` for server-to-server use.
4. Same treatment for `api/memory-admin.js`.

**Step 1 is the dangerous one.** Minting a token for whoever asks, with no
identity check, hands a token to any caller. On a single-user app where the only
user is Troy that is tolerable; the moment there is a second real user it is
not. That is a decision to make before building it, not after.

What this buys and what it does not: it authenticates a **browser that holds a
token**, not a person. Anyone holding the token is that user. Real improvement
over "anyone who can type the word troy"; still weaker than an identity
provider. If ThinkinBuddy is ever going to have more than one real user, do that
properly instead of extending this.
