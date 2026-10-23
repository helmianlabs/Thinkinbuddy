# ThinkinBuddy — technical overview

**ThinkinBuddy** is a standalone, voice-first AI companion and tutor — a
Capacitor app (Android today; an iOS project is scaffolded in this repo)
and browser PWA that runs over WiFi or cellular with no desktop
dependency.

## Core architecture

- Real-time conversational voice via ElevenLabs (the voice agent's LLM is
  configured in ElevenLabs, not in this repo), with a live tool-calling
  layer — the agent can search the web, browse URLs, generate images
  (OpenAI gpt-image-2, with Replicate Flux also routed), generate video
  (Runway gen4_turbo image-to-video live; Google Veo and HeyGen avatars
  also routed), and set alarms, all mid-conversation via server-to-server
  webhook tools gated by a shared-secret header — no browser CORS
  exposure on the generation endpoints. Text chat additionally routes
  through `lib/llm.js` to user-selectable providers; the code defaults
  are Gemini `gemini-3.5-flash-lite`, OpenAI `gpt-4.1-mini`, Anthropic
  `claude-haiku-4-5`, and xAI `grok-3-mini` (all env-overridable).
- **Persistent cross-session memory**: Neon Postgres + pgvector, OpenAI
  text-embedding-3-small embeddings, cosine-similarity recall blended with a
  recency decay. Facts the user shares get extracted and saved
  mid-conversation via a `save_memory` tool call, then surface again in
  future sessions.
- **Generated media is durable and recallable**: every image/video is
  persisted to Neon (not just displayed once and lost), with a
  semantic-search gallery in-app ("show me the image of the sunset") —
  cosine similarity + recency ranking, same underlying engine as fact
  memory.
- **8 age-scaled curricula** (finance, critical thinking, coding/AI/web
  design, leadership & business psychology, philosophy, psychology, college
  prep, academic writing) delivered via ElevenLabs' hosted Knowledge Base
  with RAG retrieval available. The curricula live in the hosted KB; this
  repo documents their structure in `docs/knowledge-base/README.md`.
- **Full session export**: PDF, Markdown, plain text, clipboard
  — built from the live conversation transcript.
- **Optional relay into a separate desktop multi-agent orchestration
  system** (Helmian, sold as the Helmian Connect tier) — per-tenant relay
  channels with one-time 6-digit device pairing, plan-gated, and built as
  a fire-and-forget text side-channel that fails silently closed, so the
  mobile app's core loop never depends on or blocks on it.
- **Safety architecture**: hardcoded guardrails in code, not just prompt
  text — `BASE_GUARDRAILS` in `lib/personality.js` rides inside every
  generated system prompt (audience is families/kids 6th grade+), and a
  parent-controlled safety mode (`lib/safety.js`, `KID_SAFETY_CORE`) adds
  stricter rules that a parent PIN locks in place. OpenAI Moderation
  screens chat input and replies, and every image/video prompt before a
  provider call is made; in safety mode a moderation outage blocks the
  generation (fail-closed) instead of waving content through.

## Engineering maturity signals

- Idempotent, self-verifying database migrations — every schema script
  writes and deletes a disposable probe row to prove the read/write path
  works before declaring success (see `scripts/setup-*.mjs`).
- Fail-closed security defaults — a missing env var locks a gate rather than
  opening it (`lib/security.js`).
- Horizontal-scale-safe polling design over Vercel's stateless serverless
  model — no reliance on in-process memory across cold starts
  (`server/handlers/latest-image.js`, `server/handlers/latest-video.js`,
  served through the single `api/[...path].js` router).

See `README.md` for the getting-started flow and `SETUP.md` for a full
from-scratch reproduction in your own ElevenLabs/Neon/OpenAI accounts.
