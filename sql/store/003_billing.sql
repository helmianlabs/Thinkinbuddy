-- sql/store/003_billing.sql — ThinkinBuddy store build, billing bite:
-- RevenueCat webhook bookkeeping + credit-pack grants.
--
-- RUN ONCE BY US (Helmian Labs) against the shared hosted Neon database,
-- AFTER sql/store/001_tenants.sql and sql/store/002_tenant_columns.sql.
-- NEVER run by end users. End users never see a database, an endpoint,
-- or a connection string; this migration is operator-side only.
--
-- Idempotent: safe to re-run. Every object is created IF NOT EXISTS.
--
-- The entitlements table itself lives in 001; this migration adds the
-- two tables the billing webhook (server/handlers/billing-webhook.js,
-- lib/billing.js) needs:
--
--   processed_billing_events — one row per RevenueCat webhook event we
--     have seen. event_id is RevenueCat's event id and the primary key,
--     which is what makes webhook redeliveries safe: applyEvent checks
--     here first and never applies the same event twice.
--     tenant_id is deliberately NOT a foreign key: this is an audit log
--     of what RevenueCat told us, and recording it must never fail just
--     because the tenant row is not visible yet (signup race, replay of
--     an old event). The value stored is the event's app_user_id, which
--     IS the tenant UUID by the appUserID rule (see lib/billing.js).
--
--   tenant_credit_grants — credits granted OUTSIDE the monthly plan
--     bucket: IAP credit packs (source 'credit_pack'), manual/promo
--     grants ('promo'), and support adjustments ('refund_adjust').
--     lib/usage.js checkBucket adds the unexpired total on top of
--     PLAN_GRANTS[plan]. expires_at NULL = the grant does not expire.

CREATE TABLE IF NOT EXISTS processed_billing_events (
  event_id     TEXT PRIMARY KEY,
  type         TEXT,
  tenant_id    UUID,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_processed_billing_events_tenant
  ON processed_billing_events (tenant_id, processed_at DESC);

CREATE TABLE IF NOT EXISTS tenant_credit_grants (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  credits    INT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'credit_pack',
  event_id   TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_credit_grants_tenant
  ON tenant_credit_grants (tenant_id, created_at DESC);

-- Belt and braces behind processed_billing_events: a credit pack bought
-- in one webhook event can only ever grant once, even if the processed
-- row were somehow missing when a redelivery lands.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_credit_grants_event_id
  ON tenant_credit_grants (event_id) WHERE event_id IS NOT NULL;
