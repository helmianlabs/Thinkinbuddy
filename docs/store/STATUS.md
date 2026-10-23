# ThinkinBuddy store build — STATUS

The single status page for turning this repo into a hosted, billed
App Store / Play Store product. Branch: `store/bite1-tenants`.
Plan: goal file `thinkinbuddy-store-plan.md`. Audit: goal file
`thinkinbuddy-bite0-audit.md`. Setup docs live alongside this file in
`docs/store/`.

Last updated: 2026-10-23 (final sweep, bite 8).

## Bites 0–8

| Bite | What | Commit | Tests |
|---|---|---|---|
| 0 | Audit of the self-hosted codebase (gaps list) | — (report only) | — |
| — | Cleanup on `main`: 5 merged branches + 33 junk scripts deleted | main only | — |
| 1 | Tenant scaffold: `sql/store/001`, `lib/tenant.js` session tokens + scoping | `8c3f944a` | 14/14 |
| 1b | Tenant wiring: core handlers resolve tenant + scope queries; compat mode preserved | `6980b18e` | 41/41 suite |
| 2 | Child safety: moderation on chat in/out + media prompts (fail-closed in safety mode), `BASE_GUARDRAILS` + `KID_SAFETY_CORE`, parent PIN helpers | `8d89d1e2` | 71/71 |
| 3 | Metering: monthly credit buckets per plan, video per-second, BYO-key unmetered, 402 before provider call when exhausted | `a9ecaa1f` | 98/98 |
| 4 | RevenueCat billing: webhook keeps entitlements true, credit packs grant on purchase, duplicate receipts safe | `8ddd8d81` | 127/127 |
| 5a | Accounts + profiles: email/password signup/login, PIN rule enforced server-side | `5a6892dc` | 153/153 |
| 5b | Onboarding front end: first-run flow, name + age band + safety/PIN setup | `e6e9250e` | 167/167 (statically verified only — no browser run) |
| 7 | Helmian Connect relay productization: per-tenant channels, 6-digit pairing (10-min, single-use), device tokens hashed, plan gate incl. lapsed plans | `501d5c64` | 185/185 |
| 6 | iOS scaffold (Capacitor, appId `com.helmianlabs.thinkinbuddy`, mic usage string), in-app account deletion, store listing + privacy drafts | `42efaf32` | 204/204 |
| 8 | Final sweep (this page) | per-file commits `7d5fa35d`…`02b502be` (see push note) | 224/224 |

**Push note (bite 8):** the connector's `push_files` snapshot route
failed twice with `403 Resource not accessible by integration` on git
tree creation, so the sweep landed as individual Contents-API commits
(one per file) plus two `delete_file` commits. Two files could NOT be
pushed through the connector at all and are listed as leftovers below:
`index.html` (126 KB — exceeds the connector's argument limit) and
`.github/workflows/ios.yml` (the GitHub App lacks the Workflows
permission — see item 11).

## Bite 8 — final sweep detail

1. **PITCH.md corrected.** Removed the false claims the audit proved:
   "React Native" (the app is Capacitor), "immutable jailbreak-resistant
   safety core" (now described as what it is: hardcoded guardrails in
   `lib/personality.js` + parent-PIN safety mode + OpenAI Moderation),
   moderation "on every prompt" (now: chat input and replies, and
   image/video prompts before provider calls), and "Claude Sonnet 4.6"
   (the voice agent's LLM is configured in ElevenLabs, not this repo;
   the text path's code defaults in `lib/llm.js` are named instead).
   No new claims beyond the code.
2. **README_CAPACITOR.md hostname.** The dead `thinkinbuddy.vercel.app`
   is gone from the app-host references; the live host is
   `thinkbuddy-sandy.vercel.app` (matches `capacitor.config.ts`).
   Same one-line fix applied to `desktop.html`'s API base.
3. **Router function config (audit fix-list #6).** Per-handler
   `export const config` was dead through the single `api/[...path].js`
   router. The router now carries `ROUTE_FUNCTION_CONFIG` /
   `ROUTE_MAX_DURATIONS` with every handler's declared values lifted
   verbatim (video paths keep 300s; `image-flux` 120s; `relay-http` 15s;
   body limits: actionable 25 MB, diary 10 MB, mcp 1 MB), and its own
   exported `config` (the only one Vercel reads) uses the maximum —
   300s / 25 MB. `video-runway-veo.js`'s bare `export const maxDuration`
   was normalized to the standard config shape. Honest limit: one
   consolidated function gets ONE platform ceiling, so a route's lower
   individual value is recorded and tested but cannot be enforced
   separately until routes split back into per-route functions. A test
   asserts the map covers every handler that declares a config.
4. **memory-admin tenant-scoped (bite 1b leftover).** Enforced mode now
   requires a tenant session (after the existing webhook-secret gate)
   and every query — list, count, get, export, audit chain, patch,
   delete — also filters `tenant_id`. Compat mode unchanged.
5. **Tool-auth flag parsing (audit gap 9).** `ENFORCE_TOOL_AUTH` had
   exactly one reader comparing against `'1'` while `.env.example`
   documented `true` — the documented setup silently did nothing. One
   shared parser now lives in `lib/security.js`
   (`isTruthyEnvFlag` / `isToolAuthEnforced`): truthy = `1`, `true`,
   `yes`, `on` (case/space-insensitive). All readers go through
   `requireToolAuth`; a test scans the code to keep it that way.
6. **Research log privacy (audit gap 11).** `/api/research-log` used to
   write the RAW conversation into a PUBLIC Vercel Blob. It now stores
   redacted metadata only: message counts per role, per-message content
   LENGTHS, and a SHA-256 hash of the participant id. No message text,
   no research tags, no age ranges. A test feeds marker strings through
   the builder and asserts none survive. **Still open (ops, see below):
   blobs written by the old version may still exist in the Blob store
   and should be purged.**
7. **Media endpoints tenant-scoped (audit gap 12).** `media-gallery`,
   `latest-image`, `latest-video`: enforced mode requires a tenant
   session (401 without one), the session tenant replaces any
   caller-supplied userId as the lookup key, gallery results also
   filter `memory_items.tenant_id`, and media written by the surviving
   generation handlers is stamped with the tenant so the filter can
   see it. Compat mode unchanged.
8. **Dead providers removed.** `video-sora.js` (OpenAI retired the
   Videos/Sora API 2026-09-24) and `image-imagen.js` (Google shut down
   Imagen 2026-08-17) are DELETED and unrouted; stale comments cleaned
   up. Surviving routes — video: Runway (`video`, `video-runway`), Veo
   (`video-runway-veo`), HeyGen (`video-heygen`); image: OpenAI
   gpt-image-2 (`image`), Replicate Flux (`image-flux`).
   `latest-video`'s Sora finalizer (kick-and-poll against the retired
   API) was removed with them. ONE cosmetic leftover: `index.html`'s
   front-end `ROUTE_PROVIDERS` map still lists the two dead routes —
   the edit is made in the working tree but the file (126 KB) exceeds
   the GitHub connector's argument limit, so it could not be pushed
   (see the push note). The entries are inert: the router 404s those
   paths, and the map only forwards BYO keys for routes the UI calls.
9. **Curricula age-gating — BLOCKED, documented, not invented.** The 8
   subject curricula live ONLY in ElevenLabs' hosted Knowledge Base.
   This repo holds no curriculum list the code can read
   (`docs/knowledge-base/README.md` is a structure template; its own
   note confirms there are no `knowledge_base` API calls in this
   codebase and the repo's prompt code hardcodes only two tutoring
   modes). The only age data anywhere is in the KB document TITLES
   (six curricula "Ages 6–Adult"; College Prep and Academic Writing
   "Grade 7–Adult") — and those documents are attached to the agent
   inside ElevenLabs, outside this repo's reach. Repo-side gating
   therefore cannot be built without first creating a repo-side
   curriculum manifest + selection path (a product task), or doing the
   gating in ElevenLabs by attaching different KB sets per agent.
   Needs Troy's age-audience decision (below) either way.
10. **.env.example** documents `SESSION_SECRET` and
    `REVENUECAT_WEBHOOK_SECRET` (names + placeholders only), and its
    Sora/Imagen references were corrected.
11. **iOS CI (`.github/workflows/ios.yml`) — WRITTEN, NOT YET ON THE
    BRANCH.** The workflow is complete and YAML-validated: Job 1 builds
    the iOS app for the simulator on macos-14 (unsigned, $0 — public
    repo) and uploads the .app; Job 2 (signed archive) is
    manual-dispatch only and SKIPS CLEANLY when the signing secrets
    (listed in the file header) are absent. BUT pushing it failed:
    `403 Resource not accessible by integration` — the Muse GitHub
    App does not hold the **Workflows** permission GitHub requires to
    write files under `.github/workflows/`, and the connector has no
    Actions dispatch tool either, so no run could be triggered from
    here. TO LAND IT (Troy, either route): (a) GitHub web UI → repo →
    Add file → Upload files → upload `.github/workflows/ios.yml`
    (the file is in the working tree / attached to the sweep report)
    and commit it to `store/bite1-tenants` — that push itself triggers
    Job 1; or (b) grant the Muse GitHub App the Workflows permission
    and ask Muse to re-push it. First run to expect: `ios-simulator-build`
    on the workflow-file push; the archive job stays dispatch-only.
12. **This file.**

## What remains Troy's (ordered)

1. **Vercel Pro upgrade** on team `dairyforge1-6376` (or wait out the
   Hobby 100-deployments/day cap) — the store-test deploy of this
   branch is still blocked by that cap.
1b. **Land the iOS workflow** (sweep item 11): upload
   `.github/workflows/ios.yml` via the GitHub web UI (or grant the
   Muse app the Workflows permission for a re-push). That push is
   also the first CI trigger. Same sitting can fix the inert
   `index.html` `ROUTE_PROVIDERS` entries (delete the `image-imagen`
   and `video-sora` lines) — the connector could not push that file.
2. **Run the DB migrations** `sql/store/001`–`005` against the real
   Neon database in a sitting together — they have NEVER been executed
   against a live Postgres.
3. **Create the store products and set prices** (RevenueCat + App Store
   Connect + Play Console). Product IDs are fixed in code/docs:
   `tb_buddy_*`, `tb_media_*`, `tb_connect_*`,
   `tb_credits_1000/5000/15000` (see `docs/store/BILLING_SETUP.md`).
   The price point itself is still Troy's open decision.
4. **Age-audience decision**: kids-directed listing (Apple Kids
   category + COPPA weight) vs family/13+ with a parent account holder.
   Blocks the listing, the age-rating answers, and how curricula
   age-gating (#9 above) gets built.
5. **Apple app record + signing**: create the App Store Connect app
   record, decide the bundle ID FIRST (the scaffold uses
   `com.helmianlabs.thinkinbuddy`; the no-Mac research recommended
   `com.thinkinbuddy.app` to match Android — the ID is permanent once
   the record exists), complete the Paid Applications agreement /
   banking / tax, enroll in the Small Business Program, and add the
   signing secrets named in `.github/workflows/ios.yml`'s header so
   the archive job can run.
6. **First Use build-site answer**: which service built the First Use
   IPA / showed the "30-minute limit" (research verdict: most likely
   Appcircle if it built + published, Appetize.io if it only streamed
   an iPhone) — decides whether that pipeline is reused.
7. **Repo description fix (manual)**: the GitHub connector has no
   repo-edit tool, so this one is a 30-second manual step — repo page →
   the gear icon next to "About" → set Description to:
   "Voice-first AI companion and tutor — Capacitor app + PWA (ElevenLabs
   voice, Neon/pgvector memory, multi-provider image/video generation)"
   (the current text falsely says "React Native").
8. **Purge the old research-log blobs** written before sweep item 6
   (public Blob store, `research/` prefix) — the code no longer writes
   raw transcripts, but the historical objects remain until deleted.
9. **Helmian-repo spoke pairing**: bite 7 productized the ThinkinBuddy
   side; the Helmian repo's spoke still needs its pairing changes
   (contract in `docs/store/HELMIAN_CONNECT.md`) before a live pair
   test can run.

## Honest unverified items

- **No live deploy of this branch yet** — blocked by the Vercel Hobby
  deployment cap (auto-retry cron is armed; see the goal timeline).
- **No live database** — `sql/store/001`–`005` have never run against a
  real Postgres; all tenant/billing/relay SQL is test-verified only.
- **Onboarding front end (5b)** was verified statically, never in a
  browser.
- **No iOS build has run** — the CI workflow itself could not be
  pushed (GitHub App lacks the Workflows permission; sweep item 11
  has the two routes to land it, after which its first run is the
  proof).
- **Relay pairing** is coded + unit-tested on the ThinkinBuddy side
  only; no live device pair has happened.
