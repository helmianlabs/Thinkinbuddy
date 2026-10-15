# thinkbuddy (Vercel, team dairyforge1-6376s-projects) — env checklist

Probe on 2026-10-15: the `thinkbuddy` project has **zero** env vars (CLI `vercel env ls production`).
Production still serves `main` (old agent `agent_4401…`, old ElevenLabs account).

Required for Mark to work end to end (Production + Preview):

| Var | Used by | Symptom when missing |
|---|---|---|
| `ELEVENLABS_API_KEY` | voices, speak, prime-agent | 5xx |
| `ELEVENLABS_POSTCALL_WEBHOOK_SECRET` | /api/conversation-webhook | 503 "webhook not configured" |
| `WEBHOOK_SECRET` | all tools (X-Webhook-Secret) | 503 on image/video tools |
| `DATABASE_URL` / `DATABASE_URL_MEMORY` | memory, recall, alarm, task, history (Neon project `thinkinbuddy`, crimson-cell-24149007) | 500 / "memory store not configured" |
| `ANTHROPIC_API_KEY` | search, chat, extract-memories | "ANTHROPIC_API_KEY not set" |
| `OPENAI_API_KEY` | image, video-sora, extract | 5xx |
| `BLOB_READ_WRITE_TOKEN` | image/video storage | 5xx |
| `CRON_SECRET` | cron-expire-memories | cron 401 |
| optional: `REPLICATE_API_TOKEN`, `GOOGLE_API_KEY`, `RUNWAY_API_KEY`, `HEYGEN_API_KEY`, `ALLOWED_ORIGINS` | flux/imagen/runway/heygen | that tool only |

After setting: Redeploy, then each tool in ElevenLabs needs header `X-Webhook-Secret` = same `WEBHOOK_SECRET`.
