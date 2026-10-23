-- sql/store/004_accounts.sql — ThinkinBuddy store build, accounts bite:
-- real email/password accounts on the tenants table (bite 1 scaffolded
-- tenants WITHOUT identity columns — accounts were a later bite, this one).
--
-- RUN ONCE BY US (Helmian Labs) against the shared hosted Neon database,
-- after sql/store/001_tenants.sql. NEVER run by end users.
--
-- Idempotent: safe to re-run. Columns are ADD COLUMN IF NOT EXISTS and the
-- unique index is CREATE UNIQUE INDEX IF NOT EXISTS.

-- ── Tenant identity ────────────────────────────────────────────────────────
-- One row per account (001). email is the login identity for the email
-- provider; it stays NULLABLE because the legacy tenant (001's fixed row)
-- and any future Apple/Google-first accounts have no email password login.
-- password_hash stores a scrypt "salt:hash" (lib/accounts.js), never a
-- password in plain text. auth_provider records how the account signs in
-- ('email' for every account this bite creates).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'email';

-- One account per email. Partial index (email IS NOT NULL) so the legacy
-- tenant and provider-first accounts without an email never collide.
-- lower(email): lib/accounts.js stores emails lowercased, and the index
-- keeps that uniqueness case-insensitive at the database level too.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_email_unique
  ON tenants (lower(email)) WHERE email IS NOT NULL;

-- ── Profiles guards ────────────────────────────────────────────────────────
-- 001 defines profiles with every column below; these IF NOT EXISTS adds
-- exist so a database created from an older 001 variant still converges.
-- They do NOT redefine the table.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS age_band TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS about_me TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS safety_mode BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS parent_pin_hash TEXT;
