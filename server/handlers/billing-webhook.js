// POST /api/billing-webhook — RevenueCat webhook receiver.
//
// RevenueCat is the single billing front door (Apple IAP + Google Play
// Billing + Stripe web — see lib/billing.js header and
// docs/store/BILLING_SETUP.md). Every purchase, renewal, cancellation,
// expiry and credit-pack buy arrives here as one event; applyEvent
// keeps entitlements + tenant_credit_grants true, idempotently.
//
// Auth is the shared secret configured in the RevenueCat dashboard
// (verifyWebhook, fail closed when REVENUECAT_WEBHOOK_SECRET is unset).
// This endpoint is server-to-server only: no CORS, no browser callers,
// no tenant session — the webhook secret IS the credential.
//
// Routed through api/[...path].js like every other handler; unlike
// api/conversation-webhook.js it needs no raw body (RevenueCat signs
// nothing — the Authorization header is the whole check), so the
// default JSON body parsing is fine.

import { verifyWebhook, applyEvent } from '../../lib/billing.js';
import { getUsageDb } from '../../lib/usage.js';

async function readEvent(req) {
  let body = req.body;
  if (body == null && typeof req.on === 'function') {
    // No parsed body (non-JSON content type, direct node call): read
    // the stream ourselves rather than guessing.
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  const event = body && typeof body === 'object' ? body.event : null;
  return event && typeof event === 'object' ? event : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyWebhook(req)) return res.status(401).json({ error: 'Unauthorized' });

  const event = await readEvent(req);
  if (!event) return res.status(400).json({ error: 'Invalid webhook body' });

  try {
    const db = await getUsageDb();
    const result = await applyEvent(db, event);
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    // A DB failure is OUR problem, not a bad event: 500 makes RevenueCat
    // retry with backoff, and applyEvent's idempotency makes the retry
    // safe. Unknown products/types never reach here as errors — they
    // come back as { applied:false } results above.
    console.error('[billing-webhook] applyEvent failed:', e?.message || e);
    return res.status(500).json({ error: 'billing_unavailable' });
  }
}
