-- sql/store/005_relay.sql — ThinkinBuddy store build, Helmian Connect
-- bite: per-tenant relay pairing (devices + one-time pairing codes) for
-- the relay that predates the store build (sql/relay.sql).
--
-- RUN ONCE BY US (Helmian Labs) against the shared hosted Neon database,
-- AFTER sql/store/001_tenants.sql (tenants must exist — both tables
-- reference it) and after sql/relay.sql (the helmion_relay tenant_id
-- add below is guarded so this file still converges a database where
-- the relay tables were never created). NEVER run by end users.
--
-- Idempotent: safe to re-run. Tables and indexes are IF NOT EXISTS and
-- the column add is IF NOT EXISTS inside a guarded block.
--
-- Secrets note: this schema stores HASHES only. relay_pairing_codes.
-- code_hash is the SHA-256 of the 6-digit code (the code itself is
-- shown to the parent once, lives 10 minutes, and is single-use);
-- relay_devices.device_token_hash is the SHA-256 of the device token
-- (the raw token is returned exactly once, at redeem time, and never
-- stored). See lib/relay.js and docs/store/HELMIAN_CONNECT.md.

-- ── Paired computers (devices) ──────────────────────────────────────────
-- One row per computer a tenant paired. The desktop spoke presents its
-- device token on every relay call; the server hashes it and looks the
-- row up — the token IS the device's credential, so revoking is one
-- UPDATE (revoked_at) and takes effect on the next call.
CREATE TABLE IF NOT EXISTS relay_devices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_label      TEXT,
  device_token_hash TEXT NOT NULL,
  paired_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_devices_token_hash
  ON relay_devices (device_token_hash);

CREATE INDEX IF NOT EXISTS idx_relay_devices_tenant
  ON relay_devices (tenant_id);

-- ── Pairing codes ───────────────────────────────────────────────────────
-- One row per code a tenant minted from the app. A code is live while
-- used_at IS NULL and expires_at is in the future. Minting a new code
-- invalidates the tenant's previous unused codes (lib/relay.js
-- createPairingCode), so at most one live code exists per tenant.
CREATE TABLE IF NOT EXISTS relay_pairing_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_relay_pairing_codes_hash
  ON relay_pairing_codes (code_hash);

CREATE INDEX IF NOT EXISTS idx_relay_pairing_codes_tenant
  ON relay_pairing_codes (tenant_id);

-- ── Tenant scoping for relay messages ───────────────────────────────────
-- helmion_relay (sql/relay.sql) predates tenancy: rows are scoped by
-- channel name only. In hosted mode the channel is DERIVED from the
-- tenant (lib/relay.js channelForTenant), so the channel alone already
-- isolates tenants; this column records the tenant explicitly on rows
-- written in hosted mode so audits never have to reverse the channel
-- name. Existing columns are untouched and compat-mode writes leave
-- tenant_id NULL, exactly as before.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_name = 'helmion_relay'
  ) THEN
    ALTER TABLE helmion_relay
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_helmion_relay_tenant
      ON helmion_relay (tenant_id);
  END IF;
END $$;
