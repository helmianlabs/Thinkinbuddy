# Deploying "Push to Scribe" — what Claude Code CANNOT do, and what Troy must do

## Why this needs a human (Troy), not Claude Code

`push_to_scribe` (in `jarvis/api/mcp.js`) POSTs `{ title, content }` to a URL read from
`process.env.SCRIBE_WEBHOOK_URL`. That URL has to be a deployed Google Apps Script
web app, and deploying an Apps Script web app requires interactive Google OAuth
consent — clicking "Deploy," "Authorize," and "Allow" inside a real, logged-in
Google account. Claude Code has no Google OAuth client, no service account, and
no way to click through Google's consent screen on Troy's behalf. This step is a
hard boundary, not a missing feature — it genuinely requires Troy's hands on his
own Google account.

Everything else (the script code itself, wiring it into the MCP tool, setting the
Vercel env var once the URL exists, committing the code) either is already done or
can be done by Claude Code as soon as Troy provides the one missing value: the
deployed `/exec` URL.

---

## Step 1 — Open script.google.com

1. Go to https://script.google.com in a browser signed into the Google account
   Troy wants the Docs created in (the account whose Drive should receive the
   documents).
2. Click **New project**.

## Step 2 — Paste the script

1. Delete the placeholder `function myFunction() {}` code in the editor.
2. Open `jarvis/scribe/PushToScribe.gs` from this repo and copy its entire contents.
3. Paste it into the Apps Script editor.
4. Rename the project (top left, "Untitled project") to something recognizable,
   e.g. `PushToScribe`.
5. Save (Ctrl+S / the disk icon).

## Step 3 — Deploy as a web app

1. Click **Deploy** (top right) → **New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Fill in the deployment settings:
   - **Description:** anything, e.g. `push_to_scribe v1`
   - **Execute as:** **Me** (troy's own Google account) — this is what lets the
     script create Docs in Troy's Drive without per-caller auth.
   - **Who has access:** **Anyone** — this is required so the Vercel serverless
     function (`jarvis/api/mcp.js`) can call it without a Google login of its own.
     (This does NOT make the Doc contents public — it only means anyone who has
     the secret `/exec` URL can trigger doc creation. Keep that URL private, the
     same way you'd keep an API key private.)
4. Click **Deploy**.
5. Google will prompt an authorization flow: **Authorize access** → pick the
   Google account → you'll likely see an "unverified app" warning since this is
   a personal script — click **Advanced** → **Go to PushToScribe (unsafe)** →
   **Allow**. This is normal for personal Apps Script projects; it's Troy's own
   script running under Troy's own account, not a third party.
6. After authorizing, Google shows a **Web app URL** ending in `/exec`. Copy that
   full URL — it looks like:
   `https://script.google.com/macros/s/AKfycb.../exec`

That URL is the value needed for `SCRIBE_WEBHOOK_URL`.

## Step 4 — Sanity-check the deployment (optional but recommended)

Paste the `/exec` URL into a browser address bar and load it (this sends a GET,
which `doGet()` in the script handles). You should see:

```json
{"ok":true,"server":"push-to-scribe","note":"POST { title, content } to create a Google Doc."}
```

If instead you see a Google sign-in page or a permission error, go back to
Step 3 and confirm "Execute as: Me" and "Who has access: Anyone" are both set
correctly, then re-deploy (Deploy → Manage deployments → edit → New version).

## Step 5 — Hand the URL to Claude Code

Once Troy has the `/exec` URL, give it to Claude Code in a future turn. From
there, Claude Code CAN finish the rest of this without further Google-side
action from Troy:

```
npx vercel env add SCRIBE_WEBHOOK_URL production
```

(run from the `jarvis` project directory, for the `thinkbuddy` Vercel project),
pasting the `/exec` URL when prompted. After that, Claude Code can push the
branch `feature/push-to-scribe` (created in this session) so the real deploy
picks up both the new `push_to_scribe` MCP tool and the env var it depends on.

## What happens if this step is skipped

Without `SCRIBE_WEBHOOK_URL` set, `pushToScribe()` in `jarvis/api/mcp.js` throws
`SCRIBE_WEBHOOK_URL env var not set — deploy the Google Apps Script first`
immediately, before attempting any network call. Claude.ai will surface that as
a tool error, not a silent failure — so this is safe to leave unset until Troy
completes Steps 1-3; the rest of the MCP server (`search_memory`, `save_to_memory`)
is unaffected.
