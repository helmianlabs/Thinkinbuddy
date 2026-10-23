-- sql/store/001_tenants.sql — ThinkinBuddy store build, bite 1: tenant scaffold.
--
-- RUN ONCE BY US (Helmian Labs) against the shared hosted Neon database —
-- the same database the app already uses via DATABASE_URL_MEMORY ||
-- DATABASE_URL (all three scripts/setup-*-db.mjs scripts share it).
-- NEVER run by end users. End users never see a database, an endpoint,
-- or a connection string; this migration is operator-side only.
--
-- Idempotent: safe to re-run. Every object is created IF NOT EXISTS and the
-- legacy-tenant insert is ON CONFLICT DO NOTHING.
--
-- Run order: this file FIRST, then sql/store/002_tenant_columns.sql
-- (002 adds tenant_id columns that reference tenants.id).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Tenants ─────────────────────────────────────────────────────────────────
-- One row per account. The account created at sign-in (Apple / Google /
-- email — next bites) IS the tenant; tenant_id is the isolation key for
-- every user-data table (see 002) and every query from bite 2 on.
CREATE TABLE IF NOT EXISTS tenants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status     TEXT NOT NULL DEFAULT 'active'
);

-- The single legacy tenant: every pre-store row in the existing tables
-- belongs to the original single user. 002 backfills existing rows to this
-- id. Fixed UUID so both migrations (and only these migrations) can name it.
INSERT INTO tenants (id, status)
VALUES ('00000000-0000-4000-8000-000000000001', 'legacy')
ON CONFLICT (id) DO NOTHING;

-- ── Profiles ────────────────────────────────────────────────────────────────
-- The ONLY "config" a user ever fills in: onboarding (name, who the buddy
-- is for, what the buddy should know). safety_mode + parent_pin_hash carry
-- the parent safety model: parent turns safety mode on, PIN-locked.
-- parent_pin_hash stores a hash, never a PIN in plain text.
CREATE TABLE IF NOT EXISTS profiles (
  tenant_id       UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  display_name    TEXT,
  age_band        TEXT,
  about_me        TEXT,
  safety_mode     BOOLEAN NOT NULL DEFAULT false,
  parent_pin_hash TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Usage ledger ────────────────────────────────────────────────────────────
-- One row per metered provider call (bite 2 writes these). cost_micros is
-- millionths of a US dollar so per-call costs stay exact integers.
-- request_id lets a retried call be recognised instead of double-charged;
-- the partial unique index enforces that where a request_id is supplied.
CREATE TABLE IF NOT EXISTS usage_ledger (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  unit        TEXT NOT NULL,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  request_id  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_ledger_tenant_created
  ON usage_ledger (tenant_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_ledger_request_id
  ON usage_ledger (request_id) WHERE request_id IS NOT NULL;

-- ── Per-user provider keys (optional BYO, Advanced/Pro only) ────────────────
-- encrypted_key + iv hold the user's own provider key encrypted at rest
-- (encryption lands with the bite that first writes these rows — master
-- keys stay server-side env, these are only the user's optional override,
-- resolved through the existing lib/userKeys.js seam).
CREATE TABLE IF NOT EXISTS user_keys (
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  iv            TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);

-- ── Entitlements ────────────────────────────────────────────────────────────
-- The billing mirror (bite 3, RevenueCat). plan/status are what the app
-- checks; revenuecat_app_user_id ties the row to the RevenueCat customer.
CREATE TABLE IF NOT EXISTS entitlements (
  tenant_id              UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan                   TEXT,
  status                 TEXT NOT NULL DEFAULT 'none',
  current_period_end     TIMESTAMPTZ,
  revenuecat_app_user_id TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
