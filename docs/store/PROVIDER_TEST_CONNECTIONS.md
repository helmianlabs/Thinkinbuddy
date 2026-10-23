# Provider test connections — guided setup sheet

**What this is:** the checklist for giving ThinkinBuddy its own separate
test connection to every provider it calls, in the order the Bite 0
audit (§4) recommended. Creating the accounts needs Troy — this sheet is
the sitting guide, not automation. Nothing here is run by end users.

**Rules for every provider below:**

- One connection **per product**, never shared: ThinkinBuddy gets its own
  accounts/keys, the same pattern as Troy's existing separate ElevenLabs
  connectors for Forge, DairyForge and Helmian. A ThinkinBuddy problem
  (or bill) can then never touch the other products, and vice versa.
- Keys live in exactly two places: the **Vercel TEST deployment's env
  vars** for ThinkinBuddy, and (for ElevenLabs) its registered connector.
  Never in the repo, never in a committed `.env`, never in chat.
- The test deployment is a **separate Vercel project** from Troy's live
  single-user ThinkinBuddy, so test keys and test traffic can't break
  the app he uses today.
- Plumbing vars the test deployment needs regardless of provider
  (from `.env.example`): `WEBHOOK_SECRET` (the tool handlers —
  image/video — refuse calls without it), `BLOB_READ_WRITE_TOKEN`
  (a Blob store **on the test project**), and, when testing hosted
  mode, `SESSION_SECRET` (setting it is what flips tenant enforcement
  and metering on — bites 1–2) plus `DATABASE_URL` /
  `DATABASE_URL_MEMORY` pointing at the test Neon project (§4).

**Done looks like:** all seven sections checked off, one successful
smoke test per provider recorded, spend caps/alerts set, and §4's SQL
results written down (that run is the first live execution of the
bite 1–2 migrations).

---

## 1. Google AI Studio — the default brain (free)

- **Sign up:** https://aistudio.google.com/app/apikey (a Google account;
  create a **new Google Cloud project** for ThinkinBuddy test — do not
  reuse a billed project: enabling billing on a project reportedly ends
  its free tier, and free + billed must stay separate).
- **Create:** one API key in that project.
- **Env vars it fills:** `GEMINI_API_KEY` (the chat brain — `lib/llm.js`
  also accepts `GOOGLE_GENAI_API_KEY`) and `GOOGLE_API_KEY`
  (`.env.example`'s name for the Imagen handler's key — the same AI
  Studio key can fill both). ⚠️ `GEMINI_API_KEY` is missing from
  `.env.example` today; noted for the docs pass.
- **Smoke test:** one chat through the app (brain = Free Gemini), or
  `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent`
  with the key and a one-line prompt. Expect a text reply.
- **Do NOT smoke-test Imagen:** the Gemini-API Imagen path was shut
  down 2026-08-17 (audit §3/§4) — `image-imagen.js` is a dead path
  awaiting a replacement decision, not a key problem.
- **Cost guardrail:** free tier only, no billing on this project.
  **Privacy:** free-tier traffic may be used by Google to improve its
  products — test with dummy personas only, never real kids' data.
  Production will need a paid-tier project for the brain.

## 2. ElevenLabs — voice (separate free test account + agent)

- **Sign up:** https://elevenlabs.io/app/sign-up — a **new account for
  ThinkinBuddy test**, not any of the existing product accounts.
- **Create:** an API key (https://elevenlabs.io/app/settings/api-keys)
  and one Conversational AI agent for testing
  (https://elevenlabs.io/app/agents) — a minimal clone: name, first
  message, one test knowledge doc. Full curriculum/agent rebuild is a
  later bite; this connection only has to prove voice works.
- **Env vars it fills:** `ELEVENLABS_API_KEY`,
  `ELEVENLABS_POSTCALL_WEBHOOK_SECRET` (the agent's post-call webhook
  HMAC secret — set the same value in the agent's webhook config).
- **Connector:** register this account the same way as the existing
  ElevenLabs connectors (Forge / DairyForge / Helmian) — one registered
  API connection named for ThinkinBuddy, so Muse's later checks use
  the connector, never a pasted key.
- **Smoke test:** `GET https://api.elevenlabs.io/v1/voices` with the key
  (the app's own `voices` handler does the same), then one `speak` call
  under 100 chars. Then one short agent conversation — and confirm the
  post-call webhook fires (the handler header says it has **never been
  verified against a live sample**; this is where that gets proven or
  fixed).
- **Cost guardrail:** free plan = 10,000 credits/month ≈ 10 min of TTS,
  **non-commercial + attribution required**. Scripted, short tests only;
  announce before any voice test so sessions never overlap Troy's.
  Production needs a paid plan — that purchase is Troy's call, later.

## 3. OpenAI — moderation (free), images, embeddings, Whisper

- **Sign up:** https://platform.openai.com — an organization/project
  for ThinkinBuddy.
- **Create:** one API key, restricted to the project
  (https://platform.openai.com/api-keys).
- **Env vars it fills:** `OPENAI_API_KEY`.
- **Smoke test:** `POST https://api.openai.com/v1/moderations` twice —
  one harmless sentence (expect `flagged:false`) and one plainly unsafe
  sentence (expect `flagged:true`). That pair is the entire child-safety
  layer's foundation, and Moderation is **free** and does not count
  toward usage limits (OpenAI Help Center). Then one embeddings call
  (`text-embedding-3-small`) and, if image testing is wanted, one
  `gpt-image-2` generation through the app's `image` handler.
- **Cost guardrail:** **set a monthly budget + alert in billing
  settings before the first non-moderation call**
  (https://platform.openai.com/settings/organization/billing) — a small
  test cap (e.g. $5–10) with an email alert at 50%. Everything except
  Moderation is pay-as-you-go; there is no free API tier.
- **Dead path:** Sora / the Videos API was retired 2026-09-24. Do not
  test `video-sora.js`; it was deliberately left unwired by the
  metering bite and awaits a replacement/removal decision.

## 4. Neon — test database (**first live run of the store SQL**)

- **Sign up:** https://console.neon.tech/signup (free plan: 100
  CU-hours/project/month, no card).
- **Create:** one project named for ThinkinBuddy test, with the
  **pgvector** extension enabled (the memory tables need it).
- **Env vars it fills:** `DATABASE_URL` and `DATABASE_URL_MEMORY`
  (point both at this one project — the repo's three setup scripts
  share a single database; bite 1 confirmed this).
- **Run, in order** (all idempotent — safe to re-run, and re-running is
  part of the check):
  1. `scripts/setup-memory-db.mjs`
  2. `scripts/setup-conversation-log-db.mjs`
  3. `scripts/setup-actionable-db.mjs`
  4. `sql/store/001_tenants.sql` (tenants, profiles, usage_ledger,
     user_keys, entitlements + the legacy tenant)
  5. `sql/store/002_tenant_columns.sql` (tenant_id on the existing
     tables, backfilled to the legacy tenant)
  6. Re-run 1–5 once more and confirm no errors (idempotency).
- **Record the results here when run:** statement output/errors per
  file, `usage_ledger` + `entitlements` present, exactly one legacy
  tenant row, every existing table carrying `tenant_id`.
  ⚠️ **This is the first live-DB verification of bites 1–2.** The SQL
  passed structural review and the tenant logic passed unit tests, but
  none of it has executed against real Postgres yet — treat any error
  here as a bite 1–2 bug to fix, not a setup mistake.
- **Smoke test:** with `SESSION_SECRET` set on the test deployment,
  sign two test tenants in (bite 1 tokens) and confirm tenant A cannot
  read tenant B's memories — the handler-level isolation proof the
  unit tests could only cover at the resolver level.
- **Cost guardrail:** free plan only; the project scales to zero when
  idle. Delete or pause it if the launch lane pauses.

## 5. Replicate — FLUX images (pay-as-you-go, cheapest images)

- **Sign up:** https://replicate.com/signin
- **Create:** one API token (https://replicate.com/account/api-tokens).
- **Env vars it fills:** `REPLICATE_API_TOKEN`.
- **Smoke test:** one `image-flux` call at the default `fast` quality
  (FLUX schnell, **$0.003/image**) through the app. A full test session
  is cents. Avoid `pro` quality while testing (flux-2-pro costs more
  per image).
- **Cost guardrail:** there is **no free tier and no hard spend cap** —
  usage bills to the account's card. Mitigation: only this one token,
  schnell-only testing, and a glance at the billing page after every
  test session. (The app-side protection lands with metering: in
  hosted mode every flux call draws the tenant's credit bucket at the
  flat image rate.)

## 6. Runway — video (125 one-time free credits, spend last)

- **Sign up:** https://app.runwayml.com/signup ; API access lives on
  the developer portal https://dev.runwayml.com.
- **Create:** one API key in the dev portal. API credits are a
  **separate pool** from web-plan credits — do not buy any; the free
  plan's 125 one-time credits (≈25 s of Gen-4 Turbo, watermarked) are
  the whole test budget.
- **Env vars it fills:** `RUNWAY_API_KEY`.
- **Smoke test:** check the account first
  (`GET https://api.dev.runwayml.com/v1/organization` with the key),
  then **one** 5-second clip through the app's `video` handler —
  supply a `promptImage` (Troy's tier is image-to-video only for Gen-4;
  pure text-to-video is rejected) — ≈25 of the 125 free credits.
- **Cost guardrail:** video is the margin risk of the whole product
  (Gen-4 Turbo $0.05/s, Gen-4.5 $0.12/s). One smoke clip, no series of
  "one more try" generations; when the free credits are gone, video
  testing **stops** until Troy decides on a paid pool.

## 7. HeyGen — avatar video (free plan; API wallet stays empty)

- **Sign up:** https://app.heygen.com/signup
- **Create:** one API key (https://app.heygen.com/settings/api-key —
  the same URL the handler names).
- **Env vars it fills:** `HEYGEN_API_KEY`.
- **Smoke test:** `GET https://api.heygen.com/v1/avatars` with the key
  (free — proves the connection without generating anything). If a real
  generation is needed, use the **dashboard's** free plan (3 videos/mo,
  ≤1 min, watermarked) rather than the API.
- **Cost guardrail:** the HeyGen **API** is separate pay-as-you-go
  starting at $5 — **do not load the API wallet during test setup.**
  Per-minute API cost (~$0.20–$0.50/min per the handler header) is a
  production decision for Troy, alongside Runway.

---

## After setup — what this unlocks

- Bites 1–2 stop being unit-test-only: tenant isolation, safety
  fail-closed behavior, and **metering** (bucket check → 402 at zero,
  ledger rows per call, BYO-key skip) can all be proven end-to-end on
  the test deployment with these connections.
- The metering bite's rates (`lib/usage.js` CREDIT_COSTS) can be
  checked against one real invoice per provider and adjusted before
  prices are set.
