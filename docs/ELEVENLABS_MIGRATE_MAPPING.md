# Old → new mapping (ThinkinBuddy / Mark)

**Migrated:** 2026-10-15T22:05:54.455Z  
**App base for new tool webhooks:** `https://thinkbuddy-sandy.vercel.app`  
**Voice:** Brian `nPczCjzI2devNBz1zQrb`

| | OLD (leave in place until Troy says delete) | NEW |
|---|---|---|
| Agent | `agent_4401kqcb0w2dey28c69zhchv7ayn` | `agent_5301m50skfnvfza8bpkmjybc18z8` |
| Name | ThinkinBuddy / Mark | ThinkinBuddy |
| Post-call webhook | (unknown — OLD key blocked) | `cd88e8ab3af94f668016293c518a5440` |
| Post-call URL | `https://thinkinbuddy.vercel.app/api/conversation-webhook` | `https://thinkbuddy-sandy.vercel.app/api/conversation-webhook` |

## New tools

| Tool | New tool_id | URL |
|---|---|---|
| `save_memory` | `tool_9501m50skdcyfb6bkjrxwjqfe6tg` | `https://thinkbuddy-sandy.vercel.app/api/memory` |
| `recall_memory` | `tool_9701m50skdsveytr9nmzjcc7baa0` | `https://thinkbuddy-sandy.vercel.app/api/recall-memory` |
| `search_web` | `tool_9701m50skecbf0faay2zzth4x905` | `https://thinkbuddy-sandy.vercel.app/api/search` |
| `browse_url` | `tool_7601m50skegkfmtrfh1hhfsee48b` | `https://thinkbuddy-sandy.vercel.app/api/browse` |
| `generate_image` | `tool_2101m50skemjewnbvbr2mfqqwq5d` | `https://thinkbuddy-sandy.vercel.app/api/image` |
| `generate_image_flux` | `tool_9901m50skerve9rbpwqtqya923f3` | `https://thinkbuddy-sandy.vercel.app/api/image-flux` |
| `generate_image_imagen` | `tool_5601m50skewwfzvvbghe3aw5s3fa` | `https://thinkbuddy-sandy.vercel.app/api/image-imagen` |
| `generate_video_sora` | `tool_0501m50skf18fdc876kez922fwf0` | `https://thinkbuddy-sandy.vercel.app/api/video-sora` |
| `generate_video_runway` | `tool_8401m50skf5mfbja2z19gzmq34qv` | `https://thinkbuddy-sandy.vercel.app/api/video-runway` |
| `save_task_for_clyde` | `tool_9801m50skf9rejwvfgg0462qk8g5` | `https://thinkbuddy-sandy.vercel.app/api/task` |
| `set_alarm` | `tool_6801m50skfdnet4rgmz96k02t2dy` | `https://thinkbuddy-sandy.vercel.app/api/alarm` |

## Verify (NEW key)

```json
{
  "name": "ThinkinBuddy",
  "voice_id": "nPczCjzI2devNBz1zQrb",
  "llm": "claude-sonnet-4-6",
  "tool_ids_count": 11,
  "max_duration_seconds": 7200,
  "post_call_webhook_id": "cd88e8ab3af94f668016293c518a5440",
  "conversation_token": {
    "ok": true,
    "detail": "signed_url_ok"
  }
}
```

Signed conversation URL: **OK** (`conversation_token.ok=true`).

## Secrets

- Post-call HMAC secret was generated on webhook create. It lives only at  
  ` /workspace/thinkbuddy-elevenlabs-migrate/webhook_secret.local ` on the agent box  
  (not committed). Troy must paste it into Vercel as `ELEVENLABS_POSTCALL_WEBHOOK_SECRET`.
- Tool header `X-Webhook-Secret` was **not** set on the new tools (we do not have  
  Vercel `WEBHOOK_SECRET`). Troy must add it to media tools (and ideally all tools)  
  to match Vercel `WEBHOOK_SECRET`, or media/generate routes will 503 once gated.

## Do not delete

OLD agent `agent_4401kqcb0w2dey28c69zhchv7ayn` and its tools stay on the OLD account until Troy explicitly says delete.
