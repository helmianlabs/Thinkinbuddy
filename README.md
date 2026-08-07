# ThinkinBuddy

A standalone AI voice companion and tutor. Runs as a Capacitor Android app
(`com.thinkinbuddy.app`) or straight in a browser at your own Vercel
deployment — no desktop required, works over WiFi or cellular.

## What it actually does (verified against source, not marketing copy)

- **Real-time conversational voice** via ElevenLabs (`@elevenlabs/client`),
  multilingual-capable, with a live web-search / URL-browse / image-gen /
  video-gen tool set the agent calls mid-conversation (`api/*.js`, wired via
  `docs/elevenlabs-template/tools.md`).
- **Persistent, per-user memory** — Neon Postgres + pgvector, OpenAI
  embeddings. The agent recalls facts across sessions (`api/memory.js`,
  `api/recall-memory.js`, `docs/persistent-memory-spec-2026-05-27.md`).
- **8 age-scaled curricula** (finance, critical thinking, coding/AI/web
  design, leadership & business psychology, philosophy, psychology, college
  prep, academic writing) taught conversationally, backed by ElevenLabs'
  hosted Knowledge Base — see `docs/knowledge-base/README.md`.
- **Image and video generation**, recallable later — every generated image
  and video is saved to Neon (`lib/mediaMemory.js`) and browsable in-app via
  the Gallery panel (`index.html` `#galleryPanel` → `/api/media-gallery`),
  with semantic search over past media ("show me the image of X").
- **Session export** — Share sheet, PDF/print, Markdown, plain text, and
  clipboard, all built from the in-browser conversation history
  (`index.html` "Export" button).
- **Optional relay into Helmion** (a separate desktop multi-agent
  orchestrator) — text-only side channel, fails silently closed if unset, so
  the app never depends on it (`lib/helmion-relay.js`).

## Getting started

1. `npm install`
2. Copy `.env.example` → `.env.local`, fill in your own keys (every value in
   the example is a placeholder — see inline comments for where each one
   comes from and what it unlocks).
3. Set up Neon Postgres with pgvector and run the migrations referenced in
   `docs/` (`migration-media-memory-2026-06-06.sql` and the memory spec).
4. `npm run dev` for the web app; see `README_CAPACITOR.md` for the Android
   APK build.
5. Recreate the ElevenLabs agent in your own account using
   `docs/elevenlabs-template/agent-config.md` and `tools.md`, and the
   Knowledge Base structure in `docs/knowledge-base/README.md`.

## Repo history note

This repo was extracted (`git subtree split`) from a monorepo that also
contained an unrelated e-commerce storefront. History here starts from that
split — full original history remains in the source monorepo.
