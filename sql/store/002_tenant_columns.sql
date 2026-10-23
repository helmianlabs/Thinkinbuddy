-- sql/store/002_tenant_columns.sql — ThinkinBuddy store build, bite 1.
--
-- RUN ONCE BY US against the shared hosted Neon database, AFTER
-- sql/store/001_tenants.sql (the tenant_id columns below reference
-- tenants.id, and the backfill points at the legacy tenant 001 creates).
-- NEVER run by end users.
--
-- Idempotent: safe to re-run. Columns are ADD COLUMN IF NOT EXISTS, the
-- backfill only touches rows where tenant_id IS NULL, indexes are
-- IF NOT EXISTS, and each table is guarded by an existence check — a
-- database that never had a given feature's setup script run is skipped,
-- not errored.
--
-- Tables covered — REAL names, read from the repo's own setup scripts
-- (all three share the DATABASE_URL_MEMORY || DATABASE_URL database):
--   scripts/setup-memory-db.mjs:          memory_items
--   scripts/setup-conversation-log-db.mjs: conversation_sessions,
--                                          conversation_turns (no user_id of
--                                          its own — tenant comes via its
--                                          session, backfilled by join below)
--   scripts/setup-actionable-db.mjs:      actionable_projects,
--                                          actionable_settings,
--                                          actionable_google_accounts,
--                                          actionable_connections,
--                                          actionable_entries,
--                                          actionable_items
-- Every table above except conversation_turns carries user_id TEXT today;
-- tenant_id is added ALONGSIDE it. user_id is not dropped in this bite —
-- handlers still read it until the wiring bite (docs/store/TENANT_WIRING.md)
-- threads tenant_id through and a later migration retires user_id.
--
-- NOT covered, deliberately: the personal MCP Memory Vault tables live in a
-- SEPARATE database (NEON_CLAUDE_MEMORY_URL, server/handlers/mcp.js +
-- relay) — that is Troy's personal infrastructure, not store user data,
-- and gets no tenant columns here.

-- Make sure the legacy tenant exists even if 001 was applied before this
-- row was added to it (same fixed UUID, same insert as 001).
INSERT INTO tenants (id, status)
VALUES ('00000000-0000-4000-8000-000000000001', 'legacy')
ON CONFLICT (id) DO NOTHING;

-- ── memory_items (scripts/setup-memory-db.mjs) ─────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'memory_items') THEN
    ALTER TABLE memory_items
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
    UPDATE memory_items
       SET tenant_id = '00000000-0000-4000-8000-000000000001'
     WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_memory_items_tenant
      ON memory_items (tenant_id);
  END IF;
END $$;

-- ── conversation_sessions (scripts/setup-conversation-log-db.mjs) ─────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'conversation_sessions') THEN
    ALTER TABLE conversation_sessions
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
    UPDATE conversation_sessions
       SET tenant_id = '00000000-0000-4000-8000-000000000001'
     WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_conv_sessions_tenant
      ON conversation_sessions (tenant_id);
  END IF;
END $$;

-- ── conversation_turns ──────────────────────────────────────────────────────
-- Backfilled from its session AFTER sessions are backfilled above, so a
-- turn inherits its own session's tenant, not a blanket value. Any orphan
-- turn whose session is missing falls back to the legacy tenant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'conversation_turns') THEN
    ALTER TABLE conversation_turns
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
    UPDATE conversation_turns t
       SET tenant_id = s.tenant_id
      FROM conversation_sessions s
     WHERE t.session_id = s.id
       AND t.tenant_id IS NULL
       AND s.tenant_id IS NOT NULL;
    UPDATE conversation_turns
       SET tenant_id = '00000000-0000-4000-8000-000000000001'
     WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_conv_turns_tenant
      ON conversation_turns (tenant_id);
  END IF;
END $$;

-- ── Actionable tables (scripts/setup-actionable-db.mjs) ────────────────────
-- Actionable's scope in the store app is a separate decision (see the bite 0
-- audit, cleanup list); its tables still hold user data today, so they get
-- tenant columns now rather than being left as an isolation hole.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'actionable_projects') THEN
    ALTER TABLE actionable_projects
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
    UPDATE actionable_projects
       SET tenant_id = '00000000-0000-4000-8000-000000000001'
     WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_actionable_projects_tenant
      ON actionable_projects (tenant_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'actionable_settings') THEN
    ALTER TABLE actionable_settings
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
    UPDATE actionable_settings
       SET tenant_id = '00000000-0000-4000-8000-000000000001'
     WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_actionable_settings_tenant
      ON actionable_settings (tenant_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'actionable_google_accounts') THEN
    ALTER TABLE actionable_google_accounts
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
    UPDATE actionable_google_accounts
       SET tenant_id = '00000000-0000-4000-8000-000000000001'
     WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_actionable_google_accounts_tenant
      ON actionable_google_accounts (tenant_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'actionable_connections') THEN
    ALTER TABLE actionable_connections
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
    UPDATE actionable_connections
       SET tenant_id = '00000000-0000-4000-8000-000000000001'
     WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_actionable_connections_tenant
      ON actionable_connections (tenant_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'actionable_entries') THEN
    ALTER TABLE actionable_entries
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
    UPDATE actionable_entries
       SET tenant_id = '00000000-0000-4000-8000-000000000001'
     WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_actionable_entries_tenant
      ON actionable_entries (tenant_id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'actionable_items') THEN
    ALTER TABLE actionable_items
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);
    UPDATE actionable_items
       SET tenant_id = '00000000-0000-4000-8000-000000000001'
     WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_actionable_items_tenant
      ON actionable_items (tenant_id);
  END IF;
END $$;
