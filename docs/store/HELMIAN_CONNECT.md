# Helmian Connect — tenant relay pairing (spoke contract)

Helmian Connect is the top ThinkinBuddy tier (locked in by Troy,
2026-10-23): everything in the base app **plus** the phone↔desktop
relay with hands into the customer's own computer — the relay that
predates Herald and was Troy's first remote control into the Helmian
desktop app. This document is the contract for the **desktop spoke**
(the Helmian-repo side): what the ThinkinBuddy side now does, what the
spoke must do, and what has NOT been proven yet.

Code: `lib/relay.js` (channels, pairing, device tokens, entitlement
gate), `server/handlers/relay-pair.js` (pairing API),
`server/handlers/relay-http.js` + `relay-proxy.js` (the relay itself,
now tenant-resolved in hosted mode), `public/connect.js` (the
Account & Safety panel). Schema: `sql/store/005_relay.sql` — run order
is `sql/relay.sql`, then `sql/store/001` → `005`, all against the one
hosted database.

## Modes — compat first

- **Compat mode** (`SESSION_SECRET` unset — Troy's live single-user
  deployment): nothing in this document applies. The relay runs on its
  legacy personal wiring: the shared `HELMION_RELAY_SECRET` /
  `MCP_SECRET`, the env channel (`HELMION_RELAY_CHANNEL`, default
  `pilot`), and relay-http's vault-database preference. Byte-for-byte
  the pre-bite behavior.
- **Hosted mode** (`SESSION_SECRET` set): identity comes from the
  caller, never from shared configuration. The personal secret and the
  `pilot` channel authenticate **nothing**. Pairing endpoints answer
  `503 { error: 'accounts_not_configured' }` in compat mode, like
  `/api/auth` and `/api/profile`.

## Channel naming rule

One channel per tenant, derived — never chosen, never configured:

```
channel = 't-' + first 16 hex chars of SHA-256(tenant_id)
```

Deterministic (every side derives it from the tenant id alone),
unguessable enough for a name that travels in URLs, and valid under
relay-http's channel rule (`/^[a-z0-9][a-z0-9_-]{1,62}$/`). Two
tenants can never share a channel in practice; a tenant's phone,
browser, and paired computer all land on the same one. In hosted mode
`relay-http` and `relay-proxy` **ignore** any channel the caller asks
for and substitute the derived one, and hosted writes stamp
`helmion_relay.tenant_id` (005) so audits never reverse the name.

## The entitlement gate

Relay access is the Connect feature, so it is gated everywhere:

- `POST /api/relay/pair/create` — non-Connect plans get
  `403 { error: 'helmian_connect_required' }`; no code is minted.
- `relay-http` / `relay-proxy` in hosted mode — a resolved caller
  whose entitlement is not `helmian_connect` in status `active` or
  `trialing` gets the same 403 before any relay row is read or
  written. A subscription that lapses therefore stops the relay,
  including for already-paired computers, on their next call.

The entitlement row (`entitlements`, 001) is kept true by the
RevenueCat webhook (`lib/billing.js`); this bite only reads it
(`lib/relay.js requireConnectEntitlement` via `lib/usage.js
getEntitlement`).

## Pairing flow, step by step

1. The parent (signed in, Connect plan) opens Settings → Account &
   Safety → **Connect a computer**. The app calls
   `POST /api/relay/pair/create` with their session token.
2. The server mints a **6-digit code**, stores only its SHA-256 hash
   (`relay_pairing_codes.code_hash`), sets a **10-minute expiry**, and
   invalidates the tenant's previous unused codes. The app shows the
   code big, with a live countdown (`public/connect.js`).
3. On the computer, the Helmian spoke asks the user for the code and
   calls `POST /api/relay/pair/redeem` with `{ code, deviceLabel }`.
   No session is involved — the code is the credential.
4. The server consumes the code (single-use: `used_at` is set; a
   second redeem of the same code fails with
   `401 { error: 'invalid_or_expired_code' }`), creates a
   `relay_devices` row, and returns
   `{ deviceToken, deviceId, channel }`.
5. The spoke stores `deviceToken` + `channel` (see token handling
   below) and from then on calls the relay as the **desktop** role:
   `GET/POST /api/relay-http?channel=<channel>&role=desktop` with
   `Authorization: Bearer <deviceToken>`. The server hashes the
   token, finds the device, substitutes the tenant's derived channel
   (the channel parameter is ignored in hosted mode), checks the
   entitlement, and stamps `last_seen_at`.
6. The phone/browser side uses `/api/relay-proxy` with the parent's
   session token, exactly as the buddy already sends text — the proxy
   derives the same channel and forwards the session token upstream.

Revocation: the parent taps **Revoke** next to a computer in the same
panel (`POST /api/relay/pair/revoke`, own devices only) — the row's
`revoked_at` is set and the token stops authenticating on the next
call. The device list (`GET /api/relay/devices`) shows labels,
`paired_at`, `last_seen_at`, `revoked_at` — and never any token
material.

## Device token handling

- 32 random bytes, hex (64 chars), minted server-side at redeem.
- **Shown once.** The raw token exists only in the redeem response and
  in the spoke's own storage. The server stores only its SHA-256 hash
  (`relay_devices.device_token_hash`, unique index). No endpoint ever
  returns the token or its hash after redeem.
- The token is the device's whole credential — the spoke must store
  it like one (OS credential store / protected config), never log it,
  and never send it anywhere except this relay as the Bearer token.
- Lose it → revoke the device in the app and pair again. There is no
  recovery path by design.

## What the helmian-repo spoke needs (separate future bite — NOT done here)

The spoke/EXE lives in the Helmian repo and was **not** edited in
this bite. To speak hosted mode it needs, exactly:

1. **Pairing UI + redeem call**: prompt for the 6-digit code, POST it
   (with a human device label, e.g. the machine's name) to
   `/api/relay/pair/redeem` on the hosted deployment, and persist the
   returned `deviceToken`, `deviceId`, and `channel`.
2. **Config change**: read the relay **channel and credential from the
   pairing result** instead of the currently hardcoded personal
   channel/secret wiring. The legacy env-style configuration stays as
   the fallback for Troy's personal deployment (compat mode).
3. **Relay calls**: send `Authorization: Bearer <deviceToken>` on
   every relay-http poll/send (role `desktop`), and treat
   `401` as "pairing gone — ask the user to pair again" and
   `403 helmian_connect_required` as "subscription lapsed — say so,
   stop polling."
4. **Token storage**: persist the device token in the OS credential
   store (or equivalent protected storage), never in plain logs or
   shared config.

Until that bite lands, the desktop end of a hosted pairing cannot
actually be exercised — see the honesty section.

## Honest limits — what this bite does NOT prove

- **No live relay round-trip was run.** Nothing here was deployed,
  and no message has travelled phone → hosted relay → desktop under
  the new tenant wiring. The code is verified by the fake-db test
  suite (`test/relay.test.mjs`) and static checks only.
- The **store test deployment is separately blocked** by Vercel's
  daily deployment cap, so even the pairing endpoints have not been
  exercised over HTTP yet.
- The **spoke changes above are unimplemented** (separate bite, Helmian
  repo). Pairing a real computer end-to-end needs them.
- SQL `005` has never run against a live Postgres (same scratch-Neon
  sitting as 001–004).
- Deployment note for the hosted build: `relay-http`'s message tables
  and the store tables must be in the **same database** in hosted
  mode (in compat mode relay-http keeps its vault-DB preference; in
  hosted mode device/entitlement lookups resolve via
  `DATABASE_URL_MEMORY || DATABASE_URL`). Operators point
  `HELMION_RELAY_URL` at the deployment's **own** `/api/relay-http` so
  the session token the proxy forwards verifies against the same
  `SESSION_SECRET`.
