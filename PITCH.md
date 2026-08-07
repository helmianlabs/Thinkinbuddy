# ThinkinBuddy — technical overview

**ThinkinBuddy** is a standalone, voice-first AI companion and tutor — a
React Native/Capacitor Android app (and browser PWA) that runs over WiFi or
cellular with no desktop dependency.

## Core architecture

- Real-time conversational voice via ElevenLabs (Claude Sonnet 4.6 as the
  underlying LLM), with a live tool-calling layer — the agent can search the
  web, browse URLs, generate images (OpenAI gpt-image-2, with Replicate Flux
  and Google Imagen wired in), generate video (Runway gen4_turbo live,
  OpenAI Sora and HeyGen wired in), and set alarms, all mid-conversation via
  10 server-to-server webhook tools gated by a shared-secret header — no
  browser CORS exposure on the generation endpoints.
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
  with RAG retrieval available.
- **Full session export**: Share sheet, PDF, Markdown, plain text, clipboard
  — built from the live conversation transcript.
- **Optional relay into a separate desktop multi-agent orchestration
  system** (Helmion) — a fire-and-forget text side-channel that fails
  silently closed, so the mobile app's core loop never depends on or blocks
  on it.
- **Safety architecture**: an immutable, jailbreak-resistant system-prompt
  safety core (explicitly refuses sexual content, violence, self-harm,
  illegal activity — audience is families/kids 6th grade+) that layers
  underneath the tutoring personality, with pre-generation content
  moderation on every image/video prompt before a provider call is even
  made.

## Engineering maturity signals

- Idempotent, self-verifying database migrations — every schema script
  writes and deletes a disposable probe row to prove the read/write path
  works before declaring success (see `scripts/setup-*.mjs`).
- Fail-closed security defaults — a missing env var locks a gate rather than
  opening it (`lib/security.js`).
- Horizontal-scale-safe polling design over Vercel's stateless serverless
  model — no reliance on in-process memory across cold starts
  (`api/latest-image.js`, `api/latest-video.js`).

See `README.md` for the getting-started flow and `SETUP.md` for a full
from-scratch reproduction in your own ElevenLabs/Neon/OpenAI accounts.
