# Actionable — setup

**Read this first: you can use Actionable tonight without creating anything.**
Jump to "The 10-minute path". Everything after it is for shipping to other people.

Nothing here was done for you: **no Google Cloud project, no OAuth client, no
account, no deploy, no EAS build.** Those cost identity, not money, so they are
yours.

---

## Your question, answered: can you reuse the Memory Vault's Google auth?

**No — because there is nothing to reuse. And you do not have to redo it either.**

I read the Memory Vault's code rather than guessing. It uses a **Google Apps
Script**, not an OAuth client:

- `claude-ai-memory-vault/.env.example:15` → the only Google setting is `DOCS_WEBHOOK_URL`
- `claude-ai-memory-vault/google-docs/DEPLOY_GUIDE.md:5-11` → that URL is "a deployed Google Apps Script web app"
- Same guide, Step 3 → **"Execute as: Me"**
- `google-docs/PushToDocs.gs:60-65` → it calls `DocumentApp.create(title)` directly

(The `extras/oauth-pro/` folder in that project is OAuth for the *MCP server
itself* — the thing Claude connects to. It has nothing to do with Google.)

**Why that matters.** An Apps Script running as *you* needs no OAuth client, no
consent screen and no verification — that is exactly why it works today with no
login. A phone app writing to *other people's* Docs is a different animal and
does need a real OAuth client. They are not interchangeable, so there is no
client ID to switch over.

**The good news.** Your deployed script accepts `{ title, content }` and returns
`{ url }` (`PushToDocs.gs:17-21`). That is **byte-for-byte the contract
Actionable speaks**. So:

> **Paste your existing Memory Vault `/exec` URL into Actionable → Settings →
> Integrations → "Google Docs (your own script)" and it works immediately.**
> Same script, same Drive, zero new setup. Both apps can use it at once.

---

## The 10-minute path — you, using it tonight

| # | Do this | Why |
|---|---|---|
| 1 | `cd thinkinbuddy` then `node scripts/setup-actionable-db.mjs "<your Neon URL>"` | creates the tables. Safe to re-run |
| 2 | `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` then `printf 'THAT' \| vercel env add ACTIONABLE_API_KEY production` | without it, anyone guessing your userId can read your journal |
| 3 | `vercel --prod` | ship the new routes |
| 4 | In `C:\Users\troyh\actionable` create `.env` with `EXPO_PUBLIC_API_BASE=https://thinkinbuddy.vercel.app` and `EXPO_PUBLIC_USER_ID=troy` | point the app at your server |
| 5 | `npx expo start`, scan with Expo Go | the app runs |
| 6 | Settings → Advanced → paste the same key from step 2 | the app can talk to the server |
| 7 | Settings → Integrations → **Google Docs (your own script)** → paste your Memory Vault `/exec` URL | entries become real Google Docs, no OAuth |

That is it. Voice, photos with OCR, search, tagging, reminders, calendar and
Google Docs all work. **No Google Cloud project needed.**

### About step 1, before you run it

That command is the one thing here that touches a real database, so: it has
**not** been run against your Neon database. It was verified against a
throwaway local PostgreSQL 17.10 cluster instead, using the script's own SQL
text — 5 tables and 13 indexes created, run twice to prove it is safe to re-run,
then a probe entry written and found by full-text search for "plumber", the tag
filter returning 2 items, a nonsense word returning 0 (so search really is
filtering), the `ON CONFLICT (user_id, slug)` upsert target confirmed, and the
item cascade-delete confirmed. All passed.

Two statements could **not** be verified locally — `CREATE EXTENSION vector` and
the `hnsw` embedding index — because pgvector is not installed on this machine.
They will work on your Neon database: `scripts/setup-memory-db.mjs:48` already
creates that same extension on that same database.

---

## Which model reads your dump, and what it costs

Structuring no longer depends on one vendor. `lib/actionable/providers.js` tries
vendors **in order** and moves to the next one when a call fails, so a billing
problem or an outage at one of them degrades the quality of an entry rather than
losing it.

Default order is **OpenAI → Gemini → Anthropic**, skipping any whose key is not
set. With your current keys that means OpenAI, then Anthropic.

| Model | Cost per capture | Measured on the real 1,815-char dump |
|---|---|---|
| `gpt-4.1-mini` **(default)** | ~$0.0032 | 9 items across 3 projects |
| `gpt-4.1-nano` | ~$0.0008 | 8 items across 4 projects, vaguer wording |
| `gemini-2.5-flash-lite` | ~$0.0008 | not measured — no Gemini key on this machine |

At 20 dumps a day the default costs about **$2 a month**. The cheaper models are
one environment variable away (`ACTIONABLE_OPENAI_MODEL`) if that ever matters.

**To put Anthropic back in front once you have topped it up** — one value, no
code change, no redeploy of anything else:

```bash
printf 'anthropic' | vercel env add ACTIONABLE_LLM_PROVIDER production
```

Deleting that variable again returns you to the default order. Every variable is
listed in `.env.actionable.example`.

If a fallback happens, the capture response says so in `warnings` and the entry
records which model actually answered in `extracted_by`. It never fails silently
to a weaker model.

---

## What changed, and what did NOT

Actionable is **added alongside** the existing Site Diary.

| File | State |
|---|---|
| `api/diary.js` | **untouched** — the live PWA still works |
| `public/diary.html` | **untouched** — thinkinbuddy.vercel.app/diary.html unaffected |
| `public/BLUEPRINT_VOICE.md` | **untouched** — the Gumroad product still matches its code |
| `api/memory.js` | **untouched** — read only, for its `getPool`/`embed` exports |
| `package.json` | **one fix, no new dependency** — it declared `"dependencies"` twice; the two blocks are merged. Nothing added or removed. Detail at the bottom of this file |

---

## Shipping to other people — the Google OAuth path

Only needed if you want *other users* to connect their own Google accounts. Your
own use is already covered above.

### Why this is much cheaper than it looks

Google sorts scopes into three classes, and the class decides the price:

| Class | Review | Extra cost |
|---|---|---|
| **restricted** (`drive`, `drive.readonly`) | **~6 weeks** | **annual paid third-party security assessment** — and transmitting through a server triggers it automatically |
| **sensitive** (`documents`, `spreadsheets`) | ~10 business days | demo video, privacy policy on a verified domain |
| **non-sensitive** (`drive.file`) | basic verification | none |

**Actionable requests non-sensitive scopes only** — `drive.file` and
`userinfo.email`. That is not a compromise: `drive.file` is an accepted scope for
`documents.create`, `documents.batchUpdate` **and** `spreadsheets.values.append`,
all verified against Google's own method references. Asking for `documents`
would buy nothing but a review.

The one real constraint: the app can only touch files **it created**. It cannot
open a doc you made by hand. That is the correct shape here, and it makes the
consent screen honest.

> ⚠️ **Do not stay in "Testing" mode as a shipping strategy.** Google issues
> refresh tokens that **expire after 7 days** for Testing-mode projects, and caps
> you at **100 hand-added test users**. Testing is fine while you are the only
> user; publish with basic verification before anyone else uses it.

### Steps

1. Create a project: <https://console.cloud.google.com/projectcreate> → name it `Actionable`
2. Enable the APIs you want (each is a search box then a blue **Enable**):
   - <https://console.cloud.google.com/apis/library/docs.googleapis.com>
   - <https://console.cloud.google.com/apis/library/drive.googleapis.com>
   - <https://console.cloud.google.com/apis/library/sheets.googleapis.com> *(only for the numeric-entry spreadsheet)*
3. Consent screen: <https://console.cloud.google.com/auth/overview> → **External** → app name `Actionable`, your email → Save
4. OAuth client: <https://console.cloud.google.com/auth/clients> → **+ Create client** → **Web application**
5. Under **Authorized redirect URIs** add **exactly**:
   ```
   https://thinkinbuddy.vercel.app/api/actionable-google-callback
   ```
6. Copy the Client ID and Client secret, then:

```bash
printf 'PASTE_CLIENT_ID'     | vercel env add GOOGLE_OAUTH_CLIENT_ID production
printf 'PASTE_CLIENT_SECRET' | vercel env add GOOGLE_OAUTH_CLIENT_SECRET production
printf 'https://thinkinbuddy.vercel.app/api/actionable-google-callback' | vercel env add GOOGLE_OAUTH_REDIRECT_URI production

node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
printf 'THE_HEX' | vercel env add ACTIONABLE_STATE_SECRET production
vercel --prod
```

`ACTIONABLE_STATE_SECRET` signs the OAuth `state` so a forged callback cannot
attach someone else's Google account to your journal. It is required for **every**
one-tap integration, not just Google.

Use `printf`, never `echo` — PowerShell's `echo` appends a `\r` that silently
corrupts the value (same gotcha as `BLUEPRINT_VOICE.md:325`).

---

## The other integrations

All of them share one callback URL — register this in each service's console:

```
https://thinkinbuddy.vercel.app/api/actionable-oauth-callback
```

### Todoist — the easiest one, do this second

Free API, no review process, and a `task:add` scope so the consent screen only
asks for what it needs.

1. <https://app.todoist.com/app/settings/integrations/app-management> → create an app
2. OAuth redirect URL → the shared callback above
3. ```bash
   printf 'CLIENT_ID'     | vercel env add TODOIST_CLIENT_ID production
   printf 'CLIENT_SECRET' | vercel env add TODOIST_CLIENT_SECRET production
   printf 'https://thinkinbuddy.vercel.app/api/actionable-oauth-callback' | vercel env add TODOIST_REDIRECT_URI production
   ```

### Notion — highest demand, one thing to check first

> 🔴 **Verify the paywall before you invest.** Notion's pricing page lists
> "Public API" as a **Plus-and-above** feature, while their help centre implies
> no such gate. I could not resolve it from primary sources and will not guess.
> Make a throwaway **Free** Notion workspace and try to add a connection. Thirty
> minutes now versus discovering mid-launch that this only works for paying
> Notion customers.

1. <https://www.notion.so/my-integrations> → New integration → **Public**
2. Redirect URI → the shared callback above
3. ```bash
   printf 'CLIENT_ID'     | vercel env add NOTION_CLIENT_ID production
   printf 'CLIENT_SECRET' | vercel env add NOTION_CLIENT_SECRET production
   printf 'https://thinkinbuddy.vercel.app/api/actionable-oauth-callback' | vercel env add NOTION_REDIRECT_URI production
   ```

Note: Notion's consent screen is a **page picker**. Whoever connects must choose
a page for entries to be filed under, or there is nowhere to write.

### Zapier / Make / custom webhook — nothing to set up

No registration, no keys, no review. The user pastes the URL that service gave
them, and Actionable POSTs JSON to it.

> 🔴 **Zapier costs the user money.** "Webhooks by Zapier" is a premium app —
> Zapier's own plan tables show Free ✗ / Professional ✓, so it needs a paid plan
> (~$20–30/mo). The app says this on the card **before** anyone connects.
> **Make.com does the same job on its free plan.**

### Deliberately not built, so nobody re-litigates it

| Service | Why |
|---|---|
| **Google Keep** | API is Workspace-enterprise only, "not available to users with personal Google accounts". Biggest note app on Android and it simply cannot be shipped |
| **Apple Notes** | No API exists, on any platform, by any architecture |
| **Apple Reminders** | On-device EventKit, iOS only. Android-first ⇒ zero users, and it would need a second device-side delivery path |
| **Obsidian** | Local-first; Sync is end-to-end encrypted *so that* an API is impossible. The honest feature is markdown export, not an integration |
| **Slack** | Real and worth building later — unlisted distribution needs no review. Queued behind the above |

---

## Troubleshooting

**"Your credit balance is too low to access the Anthropic API"**
This **no longer stops Actionable** — structuring runs on OpenAI by default and
only reaches Anthropic if the others fail (see "Which model reads your dump"
above). It **does** still break the **existing** diary app at `api/diary.js`,
which is unchanged and still calls Anthropic directly. Top up at
<https://console.anthropic.com/settings/billing> to fix that one.

**"No extraction provider configured"**
None of `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` is set on the
deployment. Any one of them is enough.

**Entries suddenly read worse than they did last week**
Check the `warnings` array on the capture response. When the first provider
fails, the entry is still structured by the next one and the warning names both
— e.g. `Structured by anthropic (...) after 1 provider(s) failed: openai (...):
HTTP 429`. A silent downgrade is the thing this warning exists to prevent.

**"Google did not return a refresh token"**
Already connected once. Remove access at
<https://myaccount.google.com/permissions>, then connect again.

**Connected Monday, broken by the weekend**
Testing-mode refresh tokens expire after 7 days. Publish the consent screen.

**`redirect_uri_mismatch`**
The console URI and the env var differ. Compare character by character — a
trailing slash is enough.

**Todoist suddenly logged out and will not reconnect**
Todoist rotates refresh tokens and revokes everything if an old one is replayed.
The code serializes refreshes with a Postgres advisory lock
(`lib/actionable/integrations/store.js`) specifically to prevent this. If it
happens anyway, disconnect and reconnect — and tell me, because it means the lock
is not holding.

---

## The `package.json` edit — who did it and why

`thinkinbuddy/package.json` shows as modified. It was **not** an `npm` normalisation:
it was a deliberate fix, made by a second Claude session working this same tree
at the same time, which had been asked to repair exactly this defect.

The file declared `"dependencies"` **twice**. JSON keeps only the last duplicate
key, so the first block — `@elevenlabs/client`, `@vercel/blob`, `openai`, `pg` —
was silently discarded by every parser that read it. It happened to be harmless
because all four also appeared in the second block at identical versions, but
it is the kind of defect that removes a package the day someone edits the wrong
block.

The two blocks are now merged into one containing all 9 packages, sorted.
Nothing was added or removed: 9 dependencies before, 9 after; `devDependencies`
and `scripts` unchanged apart from ordering. `npm install` and
`npx expo export` both run clean afterwards.

Reverting would restore the duplicate-key defect, so leave it. If you want the
original bytes back anyway:

```bash
cd C:\Users\troyh\n8n_Pod_Uploader_thinkinbuddy
git checkout HEAD -- thinkinbuddy/package.json
```
