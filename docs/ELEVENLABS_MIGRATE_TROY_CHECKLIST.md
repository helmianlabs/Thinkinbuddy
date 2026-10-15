# Troy hand checklist — ThinkinBuddy ElevenLabs migrate

Do these by hand. No DNS changes. No merges (draft PR only). Do not delete old agents yet.

## 1. Fix the OLD API key (optional but needed for a live diff)

The value we got as `ELEVENLABS_API_KEY_OLD` is **not** a valid ElevenLabs secret  
(401; does not start with `sk_`). In the **old** ElevenLabs account:

1. Profile → API Keys → create/copy a real key (`sk_…`).
2. Put it in the secure box as `ELEVENLABS_API_KEY_OLD` if you want a live export/diff later.

Old agents stay as-is until you say delete.

## 2. Vercel project `thinkbuddy` (new team)

Set / update (Production + Preview):

| Env var | Value |
|---|---|
| `ELEVENLABS_API_KEY` | **NEW** key (`sk_…` from the new account) |
| `ELEVENLABS_POSTCALL_WEBHOOK_SECRET` | HMAC secret from the new workspace webhook (agent has it in `webhook_secret.local` — ask Grok Bot to show it via secure handoff, or recreate webhook in ElevenLabs dashboard to get a fresh secret) |
| `WEBHOOK_SECRET` | keep existing shared secret used by tool routes |

Redeploy after env changes.

## 3. ElevenLabs dashboard (NEW account)

Agent already created: **`agent_5301m50skfnvfza8bpkmjybc18z8`** (ThinkinBuddy), voice Brian, 11 tools, post-call webhook wired to  
`https://thinkbuddy-sandy.vercel.app/api/conversation-webhook`.

Still do by hand:

1. Confirm Agents → ThinkinBuddy looks right (prompt, Brian, tools).
2. For each tool that spends money (`generate_*`, and ideally all tools):  
   set request header `X-Webhook-Secret` = same value as Vercel `WEBHOOK_SECRET`.
3. Settings → Webhooks: confirm `thinkinbuddy-conversation-log` URL is  
   `https://thinkbuddy-sandy.vercel.app/api/conversation-webhook` (or switch to your final production host when cut over).
4. If you change the webhook URL in the dashboard, copy the new signing secret into  
   `ELEVENLABS_POSTCALL_WEBHOOK_SECRET` and redeploy.

## 4. App / OAuth hosts (when you leave sandy)

Today Capacitor and many docs still point at `https://thinkinbuddy.vercel.app`.  
Preview host is `https://thinkbuddy-sandy.vercel.app`.

When you pick the final host:

1. `capacitor.config.ts` → `server.url`
2. Google OAuth redirect: `…/api/actionable-google-callback`
3. Todoist + Notion redirect: `…/api/actionable-oauth-callback`
4. Vercel `GOOGLE_OAUTH_REDIRECT_URI`, `TODOIST_REDIRECT_URI`, `NOTION_REDIRECT_URI`
5. `ALLOWED_ORIGINS` if set
6. Rebuild/sideload Android APK after Capacitor URL change

## 5. Merge the draft PR

After you confirm voice works on sandy with the new agent id, merge the draft PR yourself.

## 6. Later

- Delete OLD account agents/tools only when you say so.
- Knowledge-base docs were not on the NEW account (0 docs). Re-attach curriculum from  
  `docs/knowledge-base/` if you used them live before.
