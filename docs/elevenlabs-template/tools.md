# ElevenLabs Agent — Custom Tools (Webhook Config Template)

Exported from the live agent's Tools tab. Each of these is a "Webhook" type
custom tool in ElevenLabs pointing at a matching `/api/*.js` route in this
repo. **Replace `YOUR-DEPLOYMENT-URL` with your own Vercel deployment**, and
set `WEBHOOK_SECRET` in ElevenLabs' per-tool "Secret" / header config to
match your `.env`'s `WEBHOOK_SECRET` — see `lib/security.js`
(`requireWebhookSecret`), which every one of these routes calls first.

| Tool name | Endpoint | Source |
|---|---|---|
| `save_memory` | `https://YOUR-DEPLOYMENT-URL/api/memory` | `api/memory.js` |
| `generate_image` | `https://YOUR-DEPLOYMENT-URL/api/image` | `api/image.js` (OpenAI gpt-image-2) |
| `browse_url` | `https://YOUR-DEPLOYMENT-URL/api/browse` | `api/browse.js` |
| `search_web` | `https://YOUR-DEPLOYMENT-URL/api/search` | `api/search.js` |
| `save_task_for_clyde` | `https://YOUR-DEPLOYMENT-URL/api/task` | `api/task.js` |
| `generate_video_sora` | `https://YOUR-DEPLOYMENT-URL/api/video-sora` | `api/video-sora.js` (OpenAI Sora) |
| `generate_video_runway` | `https://YOUR-DEPLOYMENT-URL/api/video-runway` | `api/video-runway.js` (Runway gen4_turbo, image→video) |
| `generate_image_imagen` | `https://YOUR-DEPLOYMENT-URL/api/image-imagen` | `api/image-imagen.js` (Google Imagen 4) |
| `generate_image_flux` | `https://YOUR-DEPLOYMENT-URL/api/image-flux` | `api/image-flux.js` (Replicate Flux) |
| `set_alarm` | `https://YOUR-DEPLOYMENT-URL/api/alarm` | `api/alarm.js` |

Plus `recall_memory` (semantic recall over saved facts, `api/recall-memory.js`)
— created programmatically by `scripts/update-agent-config.mjs`, which is the
recommended way to (re)provision this tool set against your own agent via the
ElevenLabs API rather than clicking through the UI for each one.

## Built-in ElevenLabs system tools (toggle in the Agent → Tools tab)

`End conversation` and `Detect language` were enabled on the live agent.
`Skip turn`, `Update state`, `Transfer to agent`, `Transfer to number`,
`Play keypad touch tone`, and `Voicemail detection` are available but were
not enabled — turn on whichever your use case needs.

## Auth model (why two different gates exist)

- **Browser → API** (chat.js, memory reads triggered from the widget):
  CORS allowlist via `ALLOWED_ORIGINS`, enforced by
  `applyBrowserCors()` in `lib/security.js`.
- **ElevenLabs → API** (every tool above): no browser Origin header exists
  server-to-server, so these are gated by a shared-secret header
  (`X-Webhook-Secret` matching `WEBHOOK_SECRET`) via `requireWebhookSecret()`
  in the same file. Both gates are closed-by-default — a missing env var
  locks everything out rather than silently opening it.
