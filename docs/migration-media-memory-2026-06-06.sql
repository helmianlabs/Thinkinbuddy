-- migration: add blob_url column to memory_items for media (image/video) rows.
-- Run once against the DATABASE_URL_MEMORY Neon database.
-- Safe to re-run: ALTER TABLE ... ADD COLUMN IF NOT EXISTS is idempotent.
--
-- Memory rows for media use existing columns as follows:
--   scope     = 'semantic'
--   kind      = 'image' | 'video'   (new values; kind column is TEXT, no enum constraint)
--   subject   = prompt/caption (first 120 chars)
--   content   = prompt/caption (full, first 500 chars)
--   embedding = text-embedding-3-small of the prompt (1536 dims) — enables cosine recall
--   blob_url  = public Vercel Blob URL of the stored media file (NEW column)

ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS blob_url TEXT;
