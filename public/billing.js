// public/billing.js — ThinkinBuddy client billing module (RevenueCat).
//
// PLAIN ES module, no build step, loaded by the app shell as-is.
//
// ─── Source of truth ────────────────────────────────────────────────────
// NOT this file. The SERVER is: RevenueCat webhooks land on
// /api/billing-webhook and lib/billing.js keeps the entitlements table
// true; lib/usage.js checkBucket reads that table. This module is only
// the client half — it identifies the signed-in tenant to the store
// plugin and starts purchases. Anything it reports about customer info
// is display-only; a purchase is real when the webhook says so.
//
// ─── appUserID = tenant id (the rule everything hangs on) ──────────────
// configureBilling(tenantId) logs the Purchases plugin in with the
// tenant UUID as the RevenueCat appUserID, so every store purchase,
// renewal and credit pack is attributed to that tenant in the webhook
// stream. Call it right after sign-in with the same tenant id the
// server session carries, and again whenever the account changes.
//
// ─── Where the plugin comes from ────────────────────────────────────────
// The RevenueCat Capacitor plugin (@revenuecat/purchases-capacitor, in
// package.json) registers itself as window.Capacitor.Plugins.Purchases
// inside the native app after `npx cap sync`. On plain web (browser,
// PWA) there is no plugin: every export here no-ops cleanly with
// { available: false } so callers can offer billing UI only where
// purchases can actually run. Web subscriptions are sold through
// RevenueCat's Stripe billing on the website, not from this module.
//
// The onboarding bite wires this module into index.html (sign-in ->
// configureBilling -> paywall); until then nothing imports it, by
// design — billing UI without accounts would sell to nobody.

function purchasesPlugin() {
  if (typeof window === 'undefined') return null;
  return window.Capacitor?.Plugins?.Purchases || null;
}

/**
 * Identify the tenant to the store plugin.
 * @param {string} tenantId tenant UUID (becomes the RevenueCat appUserID)
 * @returns {Promise<{available: boolean, ok?: boolean, reason?: string, error?: string}>}
 */
export async function configureBilling(tenantId) {
  const plugin = purchasesPlugin();
  if (!plugin) return { available: false };
  if (!tenantId || typeof tenantId !== 'string') return { available: true, ok: false, reason: 'tenant_required' };
  try {
    if (typeof plugin.logIn === 'function') {
      await plugin.logIn({ appUserID: tenantId });
    } else if (typeof plugin.configure === 'function') {
      await plugin.configure({ appUserID: tenantId });
    } else {
      return { available: true, ok: false, reason: 'plugin_missing_login' };
    }
    return { available: true, ok: true };
  } catch (e) {
    return { available: true, ok: false, error: e?.message || String(e) };
  }
}

/**
 * The plugin's current customer info, display-only (see header). null
 * fields when the plugin is absent.
 * @returns {Promise<{available: boolean, customerInfo?: object, error?: string}>}
 */
export async function getCustomerInfo() {
  const plugin = purchasesPlugin();
  if (!plugin || typeof plugin.getCustomerInfo !== 'function') return { available: false };
  try {
    const result = await plugin.getCustomerInfo();
    return { available: true, customerInfo: result?.customerInfo || result || null };
  } catch (e) {
    return { available: true, error: e?.message || String(e) };
  }
}

/**
 * Start a purchase.
 * @param {object|string} target either { identifier, offeringIdentifier }
 *   naming the package directly (the plugin's own shape), or a single
 *   offering id string — then that offering's first package is bought.
 *   Product/package ids are the tb_* ids in lib/billing.js and
 *   docs/store/BILLING_SETUP.md.
 * @returns {Promise<{available: boolean, ok?: boolean, reason?: string,
 *   customerInfo?: object, error?: string}>} ok:true means the STORE
 *   completed the purchase; the entitlement lands when the RevenueCat
 *   webhook reaches the server (seconds later, usually).
 */
export async function purchasePackage(target) {
  const plugin = purchasesPlugin();
  if (!plugin || typeof plugin.purchasePackage !== 'function') return { available: false };
  try {
    let args = null;
    if (typeof target === 'string') {
      if (typeof plugin.getOfferings !== 'function') {
        return { available: true, ok: false, reason: 'plugin_missing_offerings' };
      }
      const { offerings } = await plugin.getOfferings();
      const offering = offerings?.all?.[target] || (offerings?.current?.identifier === target ? offerings.current : null);
      const pkg = offering?.availablePackages?.[0];
      if (!pkg) return { available: true, ok: false, reason: 'offering_not_found' };
      args = { identifier: pkg.identifier, offeringIdentifier: offering.identifier };
    } else if (target && typeof target === 'object' && target.identifier) {
      args = { identifier: target.identifier, offeringIdentifier: target.offeringIdentifier };
    }
    if (!args) return { available: true, ok: false, reason: 'package_required' };
    const result = await plugin.purchasePackage(args);
    return { available: true, ok: true, customerInfo: result?.customerInfo || null };
  } catch (e) {
    return { available: true, ok: false, error: e?.message || String(e) };
  }
}

/**
 * Restore past purchases on this device (store requirement: users must
 * be able to restore). The webhook stream re-syncs the entitlement.
 * @returns {Promise<{available: boolean, ok?: boolean, customerInfo?: object, error?: string}>}
 */
export async function restorePurchases() {
  const plugin = purchasesPlugin();
  if (!plugin || typeof plugin.restorePurchases !== 'function') return { available: false };
  try {
    const result = await plugin.restorePurchases();
    return { available: true, ok: true, customerInfo: result?.customerInfo || null };
  } catch (e) {
    return { available: true, ok: false, error: e?.message || String(e) };
  }
}
