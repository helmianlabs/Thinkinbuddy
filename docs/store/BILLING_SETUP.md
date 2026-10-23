# Billing setup — RevenueCat (Troy's account checklist)

The code half of billing is DONE (this bite):

- `lib/billing.js` — product → plan map, webhook verification, event application
- `server/handlers/billing-webhook.js` — `POST /api/billing-webhook` (registered in `api/[...path].js`)
- `sql/store/003_billing.sql` — webhook idempotency + credit-pack grant tables
- `lib/usage.js` — the monthly bucket now includes unexpired credit-pack grants
- `public/billing.js` — client module (identify tenant, start purchases, restore)
- `package.json` — `@revenuecat/purchases-capacitor` dependency added (see step 6 for install)

What remains is ACCOUNTS: products do not exist in any store until they
are created in App Store Connect, Google Play Console, and RevenueCat
with the exact ids below. Anything marked **[Troy]** needs Troy's own
Apple / Google / RevenueCat accounts — it cannot be automated or done
by an agent, because the accounts, tax/banking agreements, and identity
verification are his.

Prices are NOT in this sheet on purpose: the price for each product is
set in the stores (step 3) and is Troy's call (still open in the plan).
The ids, though, are fixed — they are compiled into `lib/billing.js`.

---

## The product ids (create them EXACTLY like this)

Subscriptions — auto-renewable. RevenueCat product ids must match the
store product ids.

| Store product id | Plan it grants | RevenueCat entitlement id |
|---|---|---|
| `tb_buddy_monthly` | buddy | `buddy` |
| `tb_buddy_yearly` | buddy | `buddy` |
| `tb_media_monthly` | buddy_media | `buddy_media` |
| `tb_media_yearly` | buddy_media | `buddy_media` |
| `tb_connect_monthly` | helmian_connect | `helmian_connect` |
| `tb_connect_yearly` | helmian_connect | `helmian_connect` |

Credit packs — consumable in-app products (bought repeatedly, granted
once per purchase by the webhook into `tenant_credit_grants`).

| Store product id | Credits granted |
|---|---|
| `tb_credits_1000` | 1,000 |
| `tb_credits_5000` | 5,000 |
| `tb_credits_15000` | 15,000 |

Plan grant sizes (monthly bucket, in `lib/usage.js` `PLAN_GRANTS`):
free 0 · buddy 10,000 · buddy_media 25,000 · helmian_connect 25,000.
Credit packs stack on top and do not expire.

---

## Step 1 — RevenueCat project **[Troy]**

1. Sign up at revenuecat.com (free tier exists; RevenueCat charges a
   percentage of tracked revenue past its free threshold — check the
   current pricing page before launch, it changes).
2. Create a project: **ThinkinBuddy**.
3. Note the project's public SDK keys later (step 6) — one per platform
   (`appl_...` for iOS, `goog_...` for Android). Public keys are safe to
   ship in the app; the SECRET in step 5 is a different thing.

## Step 2 — Connect the three storefronts **[Troy]**

In the RevenueCat project → Apps:

1. **App Store (iOS):** add the app with its bundle id. RevenueCat needs
   the App Store Connect API / in-app purchase key + the shared secret
   from App Store Connect → Users and Access / Agreements. All of this
   is generated inside Troy's Apple Developer account.
2. **Google Play (Android):** add the app with its package name.
   RevenueCat needs a Google Play service-account credentials file
   (created in Google Cloud, linked in Play Console → API access) and
   real-time developer notifications set to the RevenueCat endpoint
   RevenueCat shows you.
3. **Stripe (web):** connect the Stripe account for RevenueCat Web
   Billing — this is how subscriptions are sold on the website. Inside
   the mobile apps themselves, sales go through Apple/Google (store
   rule); Stripe is web-only here.

Also in the stores themselves **[Troy]**, before products can be sold:

- Apple: Paid Applications agreement signed, tax + banking on file in
  App Store Connect. Enroll in the **App Store Small Business Program**
  (App Store Connect → Business): under $1M/year in proceeds, Apple's
  commission on subscriptions is **15% instead of 30%**.
- Google: Payments profile complete in Play Console. Play's service
  fee is **15% for subscriptions** (and for the first $1M under the
  15% service-fee tier) — confirm current terms in Play Console.
- Prices: pick the price point per product in each store (Troy's open
  decision from the plan). Monthly + yearly for each tier; yearly is
  usually priced at ~10× monthly.

## Step 3 — Create the products **[Troy]**

Create every id from the tables above, in all three places:

1. **App Store Connect** → the app → In-App Purchases / Subscriptions:
   - One subscription group per tier (Buddy, Buddy Media, Helmian
     Connect), each holding its monthly + yearly auto-renewable
     subscription with the exact ids.
   - The three credit packs as **Consumable** in-app purchases.
2. **Google Play Console** → the app → Monetize:
   - Subscriptions with the exact ids (monthly/yearly as base plans of
     the matching tier's subscription, or separate products per id —
     ids must match the table either way).
   - The three credit packs as one-time products.
3. **RevenueCat** → Product catalog:
   - Import/add the same products for each storefront app.
   - Create entitlements `buddy`, `buddy_media`, `helmian_connect` and
     attach the matching subscription products to each.
   - Credit packs get NO entitlement — the webhook grants their credits
     directly (that logic is already coded).
   - Create an Offering (make it "current") with a package per product,
     so the client's purchase flow has something to sell.

Nothing here can be created by an agent: App Store Connect and Play
Console product creation is tied to Troy's developer accounts, paid
agreements, and in Apple's case review of the first IAP with the app.

## Step 4 — Run the database migration (us, once)

Against the hosted Neon database, after 001/002:

```
sql/store/003_billing.sql
```

Creates `processed_billing_events` + `tenant_credit_grants`. This is
the same step pattern as the scratch-Neon run in
PROVIDER_TEST_CONNECTIONS.md — do it there first.

## Step 5 — Webhook + secret **[Troy creates the secret value; we set env]**

1. RevenueCat project → Integrations → Webhooks → add:
   - **URL:** `https://<the hosted deployment>/api/billing-webhook`
   - **Authorization header:** `Bearer <a long random secret>`
     (generate one, e.g. `openssl rand -hex 32`).
2. Set that same secret in the deployment's environment:
   `REVENUECAT_WEBHOOK_SECRET=<the secret>` (Vercel project env).
   The server demands an exact match and fails closed when the env var
   is missing — an unset secret means ALL webhook calls 401, on
   purpose.
3. Send a test event from the RevenueCat dashboard and confirm the
   delivery shows 200. A subscription test event should appear as a row
   in `processed_billing_events`.

## Step 6 — Client install (coding side, with the iOS/onboarding bites)

1. `npm install` (picks up `@revenuecat/purchases-capacitor` from
   package.json; also refreshes package-lock.json, which this bite did
   not regenerate) then `npx cap sync`.
   - Version note: the dependency is pinned `^9.0.0` — v9.0.1 is the
     Capacitor 6 line (peer dep `@capacitor/core ^6.0.0`, matching this
     app). The newest plugin line (13.x) targets Capacitor 8; do NOT
     upgrade the pin until the Capacitor upgrade bite.
2. Give the app the platform public SDK keys from step 1 (app config,
   onboarding bite — public keys are not secrets).
3. Signed-in flow: after login, call `configureBilling(tenantId)` from
   `public/billing.js` with the tenant UUID — this is what makes
   webhook `app_user_id` equal the tenant id. Selling before sign-in
   breaks attribution; the paywall goes after account creation.

## Step 7 — Sandbox test before any real money

1. iOS: Sandbox tester account (App Store Connect) or StoreKit testing;
   Android: license testers in Play Console.
2. Buy `tb_buddy_monthly` in sandbox → RevenueCat dashboard shows the
   event → webhook delivery 200 → `entitlements` row for the tenant
   reads plan `buddy`, status `active`.
3. Buy `tb_credits_1000` → a `tenant_credit_grants` row appears and
   `checkBucket` for the tenant shows the extra 1,000 in `grants`.
4. Cancel in the store sandbox → `CANCELLATION` event → status
   `cancelled`, plan unchanged until the sandbox expiry, then
   `EXPIRATION` → plan `free`.

---

## Who does what — summary

| Step | Owner |
|---|---|
| All billing code (webhook, mapping, grants, client module) | ✅ Done (this bite) |
| RevenueCat account + project | **[Troy]** |
| Apple Developer / Play Console agreements, tax, banking | **[Troy]** |
| Small Business Program enrollment (Apple 15%) | **[Troy]** |
| Store products created with the exact ids | **[Troy]** (in his store accounts) |
| RevenueCat product mapping, entitlements, offering | **[Troy]** (in his RevenueCat project) |
| Stripe connection for web billing | **[Troy]** (his Stripe account) |
| Webhook URL + Authorization secret in RevenueCat | **[Troy]** generates the secret |
| `REVENUECAT_WEBHOOK_SECRET` in the deployment env | Us, with Troy's secret value |
| `sql/store/003_billing.sql` run | Us (scratch Neon first) |
| Prices per product | **[Troy]** decides; entered in the stores |
| `npm install` + `cap sync` + SDK keys into app config | Us, in the iOS/onboarding bites |
| Sandbox end-to-end test | Together (Troy's tester accounts, our checklist above) |
