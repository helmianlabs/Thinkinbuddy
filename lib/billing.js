// lib/billing.js — RevenueCat billing for the ThinkinBuddy hosted model
// (store bite: billing). See docs/store/BILLING_SETUP.md for the account
// setup this code expects, and the store plan's billing section.
//
// ─── The shape of the money ─────────────────────────────────────────────
// Store rule: digital subscriptions sold INSIDE the app go through Apple
// In-App Purchase (iOS) and Google Play Billing (Android) — Stripe alone
// inside the app gets the app rejected. RevenueCat wraps Apple IAP +
// Play Billing + Stripe (web) behind one product catalog and one
// webhook stream, so this server only ever talks to RevenueCat:
//
//   store purchase -> RevenueCat -> POST /api/billing-webhook
//     (server/handlers/billing-webhook.js) -> applyEvent() below ->
//     entitlements (sql/store/001) + tenant_credit_grants (sql/store/003)
//     stay true. lib/usage.js checkBucket reads them; nothing else in
//     the app decides who has paid.
//
// Plans are the PLAN_GRANTS keys in lib/usage.js (free, buddy,
// buddy_media, helmian_connect) — this file maps store products to
// those plan names and never duplicates the grant numbers.
//
// ─── app_user_id IS the tenant id ───────────────────────────────────────
// The client sets the RevenueCat appUserID to the tenant UUID at login
// (public/billing.js configureBilling). Every webhook event therefore
// names its tenant in event.app_user_id, and entitlements rows are
// keyed by it directly. An event whose app_user_id is not one of our
// tenant ids cannot be applied to anyone (applyEvent says so, records
// the event, and moves on — webhooks must never throw on bad input,
// or RevenueCat redelivers garbage forever).
//
// ─── Webhook auth ───────────────────────────────────────────────────────
// RevenueCat sends the Authorization header configured in its dashboard
// (Project -> Integrations -> Webhooks). We configure the value there
// as `Bearer <REVENUECAT_WEBHOOK_SECRET>` and verifyWebhook() demands
// an exact, timing-safe match. If REVENUECAT_WEBHOOK_SECRET is unset
// the check FAILS CLOSED: a billing endpoint that cannot verify its
// caller must not accept "trust me" purchase events.
//
// ─── Idempotency ────────────────────────────────────────────────────────
// RevenueCat redelivers events (retries, dashboard replays). Every
// event carries a unique id; applyEvent records it in
// processed_billing_events and applies each id at most once. Unknown
// products and unknown event types are recorded too (so a replay is a
// cheap duplicate, not a second decision) and reported as not applied.
//
// DB access mirrors lib/usage.js: every DB function takes a pg
// Pool/client as its first argument so tests pass a fake.

import { timingSafeEqual } from 'node:crypto';

/** RevenueCat store product id -> entitlements.plan (lib/usage.js PLAN_GRANTS keys). */
export const PRODUCT_PLANS = {
  tb_buddy_monthly: 'buddy',
  tb_buddy_yearly: 'buddy',
  tb_media_monthly: 'buddy_media',
  tb_media_yearly: 'buddy_media',
  tb_connect_monthly: 'helmian_connect',
  tb_connect_yearly: 'helmian_connect',
};

/** RevenueCat consumable product id -> credits granted on top of the monthly bucket. */
export const CREDIT_PACKS = {
  tb_credits_1000: 1000,
  tb_credits_5000: 5000,
  tb_credits_15000: 15000,
};

export function planForProduct(productId) {
  return PRODUCT_PLANS[productId] || null;
}

export function creditsForPack(productId) {
  return CREDIT_PACKS[productId] || 0;
}

function rowsOf(result) {
  if (Array.isArray(result)) return result;
  return result?.rows || [];
}

function timingSafeStringEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * True iff the request carries the webhook Authorization header exactly
 * as configured in the RevenueCat dashboard: `Bearer <secret>`, where
 * <secret> is process.env.REVENUECAT_WEBHOOK_SECRET. Unset secret ->
 * false (fail closed; see header).
 * @param {import('http').IncomingMessage} req
 */
export function verifyWebhook(req) {
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (!secret) return false;
  const header = req?.headers?.authorization ?? req?.headers?.Authorization ?? '';
  return timingSafeStringEqual(header, `Bearer ${secret}`);
}

/**
 * Pure mapping from one RevenueCat webhook event (the object inside the
 * webhook body's `event` field: { id, type, app_user_id, product_id,
 * expiration_at_ms, ... }) to what should happen to the tenant.
 *
 * Returns one of:
 *   { kind: 'subscription', tenantId, plan, status, currentPeriodEnd }
 *     plan is null for status-only changes (CANCELLATION /
 *     BILLING_ISSUE for a product we don't map): applyEvent keeps the
 *     tenant's existing plan and updates status/expiry only.
 *   { kind: 'credit_pack', tenantId, credits }
 *   null — nothing applicable (unknown event type, unknown product on
 *     a purchase event, or no app_user_id to attribute it to).
 *
 * Status vocabulary matches entitlements.status usage elsewhere:
 * 'active' | 'cancelled' (plan keeps running until current_period_end)
 * | 'expired' (plan drops to 'free') | 'billing_issue' (store could not
 * charge; plan kept while the store retries).
 */
export function planFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const tenantId = typeof event.app_user_id === 'string' && event.app_user_id ? event.app_user_id : null;
  if (!tenantId) return null;

  const productId = event.product_id || null;
  const periodEnd = event.expiration_at_ms != null && Number.isFinite(Number(event.expiration_at_ms))
    ? new Date(Number(event.expiration_at_ms))
    : null;

  // Credit packs are consumables: a purchase event for a pack product
  // grants credits; packs have no subscription lifecycle.
  const packCredits = creditsForPack(productId);
  if (packCredits > 0) {
    if (event.type === 'INITIAL_PURCHASE' || event.type === 'NON_RENEWAL_PURCHASE') {
      return { kind: 'credit_pack', tenantId, credits: packCredits };
    }
    return null;
  }

  const plan = planForProduct(productId);
  switch (event.type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'PRODUCT_CHANGE':
      if (!plan) return null; // a subscription purchase we cannot map
      return { kind: 'subscription', tenantId, plan, status: 'active', currentPeriodEnd: periodEnd };
    case 'CANCELLATION':
      // Auto-renew off. The plan itself runs until the period ends, so
      // only the status changes; expiry arrives as EXPIRATION.
      return { kind: 'subscription', tenantId, plan, status: 'cancelled', currentPeriodEnd: periodEnd };
    case 'EXPIRATION':
      return { kind: 'subscription', tenantId, plan: 'free', status: 'expired', currentPeriodEnd: periodEnd };
    case 'BILLING_ISSUE':
      return { kind: 'subscription', tenantId, plan, status: 'billing_issue', currentPeriodEnd: periodEnd };
    default:
      return null;
  }
}

async function recordProcessedEvent(db, event, tenantId) {
  await db.query(
    `INSERT INTO processed_billing_events (event_id, type, tenant_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id) DO NOTHING`,
    [event.id, event.type || null, tenantId || null],
  );
}

/**
 * Apply one RevenueCat webhook event to the database. Idempotent on
 * event.id (see header). Never throws on unknown input — unknown
 * products/types are recorded and reported; only genuine DB failures
 * propagate (the handler answers 500 so RevenueCat retries those).
 *
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {object} event the webhook event object (body.event)
 * @returns {Promise<{ applied: boolean, reason?: string, kind?: string,
 *                     tenantId?: string, plan?: string, credits?: number }>}
 */
export async function applyEvent(db, event) {
  if (!db || typeof db.query !== 'function') throw new Error('applyEvent: db (pg pool/client) required');
  if (!event || typeof event !== 'object' || !event.id) {
    return { applied: false, reason: 'invalid_event' };
  }

  const seen = await db.query(
    `SELECT event_id FROM processed_billing_events WHERE event_id = $1`,
    [event.id],
  );
  if (rowsOf(seen).length > 0) return { applied: false, reason: 'duplicate' };

  const tenantId = typeof event.app_user_id === 'string' && event.app_user_id ? event.app_user_id : null;
  const action = planFromEvent(event);

  if (!action) {
    await recordProcessedEvent(db, event, tenantId);
    return {
      applied: false,
      reason: tenantId ? 'unknown_product' : 'missing_app_user_id',
      ...(tenantId ? { tenantId } : {}),
    };
  }

  if (action.kind === 'credit_pack') {
    try {
      await db.query(
        `INSERT INTO tenant_credit_grants (tenant_id, credits, source, event_id)
         VALUES ($1, $2, 'credit_pack', $3)`,
        [action.tenantId, action.credits, event.id],
      );
    } catch (e) {
      // The partial unique index on event_id (sql/store/003) fired: this
      // pack was already granted by the first delivery of this event.
      if (e && (e.code === '23505' || /duplicate key|unique constraint/i.test(e.message || ''))) {
        await recordProcessedEvent(db, event, tenantId);
        return { applied: false, reason: 'duplicate', tenantId: action.tenantId };
      }
      throw e;
    }
    await recordProcessedEvent(db, event, tenantId);
    return { applied: true, kind: 'credit_pack', tenantId: action.tenantId, credits: action.credits };
  }

  // Subscription lifecycle: upsert the entitlements row. plan NULL in
  // the action means "status-only change" — COALESCE keeps the plan the
  // tenant already has. Same for a missing period end.
  await db.query(
    `INSERT INTO entitlements (tenant_id, plan, status, current_period_end, revenuecat_app_user_id, updated_at)
     VALUES ($1, $2, $3, $4, $1, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       plan = COALESCE(EXCLUDED.plan, entitlements.plan),
       status = EXCLUDED.status,
       current_period_end = COALESCE(EXCLUDED.current_period_end, entitlements.current_period_end),
       revenuecat_app_user_id = EXCLUDED.revenuecat_app_user_id,
       updated_at = now()`,
    [action.tenantId, action.plan, action.status, action.currentPeriodEnd],
  );
  await recordProcessedEvent(db, event, tenantId);
  return {
    applied: true,
    kind: 'subscription',
    tenantId: action.tenantId,
    ...(action.plan ? { plan: action.plan } : {}),
  };
}
