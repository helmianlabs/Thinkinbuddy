# Setup — reproduce this from scratch in your own accounts

This mirrors the live product's setup exactly, minus any real credentials or
data. Nothing here connects back to the original author's accounts.

## 1. Clone and install

```
git clone <this-repo-url>
cd thinkinbuddy
npm install
```

## 2. Create your own accounts

- **ElevenLabs** (Conversational AI) — free tier works for evaluation.
- **Neon** (Postgres, free tier) — create a project, note the connection
  string (Dashboard → Connection Details).
- **OpenAI** — for image gen, moderation, and memory embeddings.
- Optional: **Runway**, **Replicate**, **Google AI Studio** (Imagen),
  **HeyGen** — only needed if you want the image/video tools beyond OpenAI's.
- Optional: **Vercel Blob** store — needed for generated images/videos to
  have a public URL (Vercel Dashboard → Storage → Blob → create store).

## 3. Environment

```
cp .env.example .env.local
```

Fill in each key — see the comments in `.env.example` for what each one
unlocks and which are required vs optional. `DATABASE_URL` /
`DATABASE_URL_MEMORY` is your new Neon connection string from step 2.

## 4. Build the database schema (empty — no data)

Three idempotent setup scripts build the full schema and self-verify with a
disposable probe row they insert and delete — they never touch real data,
and are safe to re-run:

```
node scripts/setup-memory-db.mjs "postgresql://...your-neon-connection-string..."
node scripts/setup-conversation-log-db.mjs "postgresql://...same connection string..."
node scripts/setup-actionable-db.mjs "postgresql://...same connection string..."
```

Each prints `✅ ALL CHECKS PASSED` when the schema and the hot read/write
path both work. This creates:

- `memory_items` — persistent per-user memory + generated media rows
  (pgvector, cosine recall).
- `conversation_sessions` / `conversation_turns` — live transcript log.
- `actionable_*` (5 tables) — the brain-dump/task-extraction module.

Optional — only if you want to demo the desktop-relay feature against your
own second app instance (NOT required for ThinkinBuddy to work standalone):

```
psql "$DATABASE_URL" -f sql/relay.sql
```

Then run the media migration (idempotent, adds one column):

```
psql "$DATABASE_URL" -f docs/migration-media-memory-2026-06-06.sql
```

## 5. Recreate the ElevenLabs agent

Follow `docs/elevenlabs-template/agent-config.md` (system prompt + settings)
and `docs/elevenlabs-template/tools.md` (the 10 custom tool webhooks, pointed
at your own deployment URL once you have one). Optionally add your own
Knowledge Base documents per `docs/knowledge-base/README.md`'s structure —
the 8-curriculum shape is documented there; the text itself is yours to
write or adapt.

## 6. Run it

```
npm run dev
```

For the Android build, see `README_CAPACITOR.md`.

## Result

At this point you have a byte-for-byte identical ThinkinBuddy — same schema,
same agent shape, same tool set — running entirely on your own accounts with
zero data and zero credentials from the original deployment.
