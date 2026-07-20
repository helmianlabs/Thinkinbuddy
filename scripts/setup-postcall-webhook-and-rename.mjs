// scripts/setup-postcall-webhook-and-rename.mjs
// ---------------------------------------------------------------------------
// 1. Renames the agent from "Jarvis" (leftover from the original bootstrap
//    script, create-agent.js) to "ThinkinBuddy", matching the app's actual
//    branding everywhere else.
// 2. Creates a workspace webhook (POST /v1/workspace/webhooks) pointing at
//    api/conversation-webhook.js and wires it to this agent via
//    platform_settings.workspace_overrides.webhooks.post_call_webhook_id --
//    confirmed via a live GET on the agent that this is a per-agent override
//    field, not workspace-global-only as the docs implied.
// 3. Prints the webhook_secret so it can be set as
//    ELEVENLABS_POSTCALL_WEBHOOK_SECRET in Vercel (all environments), then
//    the app needs a redeploy to pick it up (api/conversation-webhook.js is
//    fail-closed without that secret).
// ---------------------------------------------------------------------------
import { readFileSync } from 'fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const AGENT_ID = 'agent_4401kqcb0w2dey28c69zhchv7ayn';
const WEBHOOK_URL = 'https://jarvis-troy.vercel.app/api/conversation-webhook';
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error('ELEVENLABS_API_KEY not set'); process.exit(1); }

async function api(path, opts = {}) {
  const r = await fetch(`https://api.elevenlabs.io/v1${path}`, {
    ...opts,
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

(async () => {
  console.log('[1/4] Renaming agent Jarvis -> ThinkinBuddy...');
  const before = await api(`/convai/agents/${AGENT_ID}`);
  console.log(`      was: "${before.name}"`);
  await api(`/convai/agents/${AGENT_ID}`, { method: 'PATCH', body: JSON.stringify({ name: 'ThinkinBuddy' }) });
  console.log('      now: "ThinkinBuddy"');

  console.log('[2/4] Checking for an existing webhook pointing at this URL (avoid duplicates)...');
  const existingList = await api('/workspace/webhooks');
  const existing = (existingList.webhooks || []).find((w) => w.webhook_url === WEBHOOK_URL || w.name === 'thinkinbuddy-conversation-log');
  let webhookId, webhookSecret = null;
  if (existing) {
    webhookId = existing.webhook_id;
    console.log(`      already exists: ${webhookId} (secret not re-shown by the API on lookup -- if it's not already in Vercel, delete and re-run this script to get a fresh one)`);
  } else {
    console.log('[2/4] Creating workspace webhook...');
    const created = await api('/workspace/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        settings: { auth_type: 'hmac', name: 'thinkinbuddy-conversation-log', webhook_url: WEBHOOK_URL, request_headers: {} },
      }),
    });
    webhookId = created.webhook_id;
    webhookSecret = created.webhook_secret;
    console.log(`      created: ${webhookId}`);
  }

  console.log('[3/4] Wiring webhook to this agent (platform_settings.workspace_overrides.webhooks.post_call_webhook_id)...');
  const agent = await api(`/convai/agents/${AGENT_ID}`);
  const ps = agent.platform_settings;
  ps.workspace_overrides = ps.workspace_overrides || {};
  ps.workspace_overrides.webhooks = ps.workspace_overrides.webhooks || { events: ['transcript'], transcript_format: 'json', send_audio: false };
  ps.workspace_overrides.webhooks.post_call_webhook_id = webhookId;
  await api(`/convai/agents/${AGENT_ID}`, { method: 'PATCH', body: JSON.stringify({ platform_settings: ps }) });

  console.log('[4/4] Verifying...');
  const verify = await api(`/convai/agents/${AGENT_ID}`);
  const ok1 = verify.name === 'ThinkinBuddy';
  const ok2 = verify.platform_settings.workspace_overrides.webhooks.post_call_webhook_id === webhookId;
  console.log(`      name = ThinkinBuddy: ${ok1 ? 'OK' : 'FAILED'}`);
  console.log(`      post_call_webhook_id wired: ${ok2 ? 'OK' : 'FAILED'}`);

  if (webhookSecret) {
    console.log('\n=== WEBHOOK SECRET (set as ELEVENLABS_POSTCALL_WEBHOOK_SECRET) ===');
    console.log(webhookSecret);
    console.log('===================================================================');
  } else {
    console.log('\nNo new secret generated (webhook already existed). If ELEVENLABS_POSTCALL_WEBHOOK_SECRET isn\'t already set correctly in Vercel, the webhook needs to be deleted and recreated to get a fresh secret.');
  }
  if (!ok1 || !ok2) process.exitCode = 1;
})().catch((e) => { console.error('\n✗ FAILED:', e.message); process.exitCode = 1; });
