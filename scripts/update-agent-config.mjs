// scripts/update-agent-config.mjs
// ---------------------------------------------------------------------------
// Updates the live ElevenLabs agent + its tools. This agent has migrated to
// the newer tool-registry model: tools are standalone objects (their own
// tool_xxx id, managed via /v1/convai/tools) that the agent REFERENCES via
// conversation_config.agent.prompt.tool_ids -- NOT inline tool definitions
// on the agent itself (the GET response still echoes a `tools` array for
// convenience, but PATCHing the agent with BOTH `tools` and `tool_ids`
// present is rejected: "Cannot specify both tools and tool IDs"). Discovered
// live via a failed first attempt at this script -- fixed here.
//
// Changes made:
//   1. Agent: conversation_config.conversation.max_duration_seconds 3600 -> 7200
//      (Troy asked for ~2hr headroom. NOTE: this was already 3600s [1hr], not
//      the 600s default, so it did NOT cause the 15-minute call Troy lost --
//      that's what conversation-turn.js / conversation-webhook.js fix.)
//   2. Tool `save_memory` (tool_5501kt5r8fqyf3xssf9xw0v3fw3y): adds a userId
//      property bound to the {{user_id}} dynamic variable index.html already
//      sets every session (index.html:690-693). FIXES A REAL LIVE BUG found
//      via this same investigation: the tool has been called 34 times per
//      its own usage_stats with NO userId param, and api/memory.js requires
//      userId -- every one of those 34 in-call saves has been failing.
//   3. Creates a NEW tool `recall_memory` (api/recall-memory.js), same
//      {{user_id}} binding, and appends its id to the agent's tool_ids.
//
// USAGE: node scripts/update-agent-config.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from 'fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const AGENT_ID = 'agent_4401kqcb0w2dey28c69zhchv7ayn';
const SAVE_MEMORY_TOOL_ID = 'tool_5501kt5r8fqyf3xssf9xw0v3fw3y';
const APP_BASE = process.argv[2] || 'https://thinkinbuddy.vercel.app';
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

// The API rejects setting more than one of {description, dynamic_variable,
// is_system_provided, constant_value, is_omitted} on a param at once --
// discovered live via a 422 on the first attempt (which had both
// description text AND dynamic_variable set). dynamic_variable alone is
// the correct binding to {{user_id}}.
const userIdParamPatch = {
  type: 'string',
  description: '',
  enum: null,
  is_system_provided: false,
  dynamic_variable: 'user_id',
  allowed_values_dynamic_variable: '',
  constant_value: '',
  is_omitted: false,
};

(async () => {
  console.log('[1/5] Fetching save_memory tool...');
  const saveMemoryTool = await api(`/convai/tools/${SAVE_MEMORY_TOOL_ID}`);
  const smConfig = saveMemoryTool.tool_config;

  console.log('[2/5] Fixing save_memory (userId was missing -> in-call saves 400ing)...');
  if (!smConfig.api_schema.request_body_schema.properties.userId) {
    smConfig.api_schema.request_body_schema.properties.userId = userIdParamPatch;
    smConfig.api_schema.request_body_schema.required = Array.from(
      new Set([...(smConfig.api_schema.request_body_schema.required || []), 'userId'])
    );
    await api(`/convai/tools/${SAVE_MEMORY_TOOL_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ tool_config: smConfig }),
    });
    console.log('      save_memory: userId param added and saved.');
  } else {
    console.log('      save_memory: userId param already present, left as-is.');
  }

  console.log('[3/5] Creating recall_memory tool...');
  const recallToolConfig = {
    type: 'webhook',
    name: 'recall_memory',
    description: 'Look up something specific you might already know about the user or a past conversation, mid-call. Use this whenever the user references something you might have saved before (a name, a project, a preference, a past decision) and you are not certain you already have it in context -- silently, without announcing it.',
    response_timeout_secs: 10,
    disable_interruptions: false,
    interruption_mode: 'allow',
    force_pre_tool_speech: false,
    pre_tool_speech: 'auto',
    assignments: [],
    tool_call_sound: null,
    tool_call_sound_behavior: 'auto',
    tool_error_handling_mode: 'auto',
    dynamic_variables: { dynamic_variable_placeholders: {} },
    execution_mode: 'immediate',
    api_schema: {
      request_headers: {},
      url: `${APP_BASE}/api/recall-memory`,
      method: 'POST',
      path_params_schema: {},
      query_params_schema: null,
      request_body_schema: {
        description: 'Recall a saved fact matching a query.',
        dynamic_variable: '',
        is_omitted: false,
        type: 'object',
        required: ['userId', 'query'],
        properties: {
          userId: userIdParamPatch,
          query: {
            type: 'string',
            description: 'What to look up, in your own words (e.g. "his daughter\'s name" or "the DairyForge launch date")',
            enum: null,
            is_system_provided: false,
            dynamic_variable: '',
            allowed_values_dynamic_variable: '',
            constant_value: '',
            is_omitted: false,
          },
        },
      },
      response_body_schema: null,
      response_filter: null,
      content_type: 'application/json',
      auth_resolved_params: [],
      auth_connection: null,
    },
  };

  const allTools = await api('/convai/tools');
  const existingRecall = (allTools.tools || []).find((t) => t.tool_config?.name === 'recall_memory');
  let recallToolId;
  if (existingRecall) {
    recallToolId = existingRecall.id;
    console.log('      recall_memory tool already exists:', recallToolId, '(reusing)');
  } else {
    const created = await api('/convai/tools', { method: 'POST', body: JSON.stringify({ tool_config: recallToolConfig }) });
    recallToolId = created.id;
    console.log('      recall_memory tool created:', recallToolId);
  }

  console.log('[4/5] Fetching agent + updating conversation config + tool_ids...');
  const agent = await api(`/convai/agents/${AGENT_ID}`);
  const cc = agent.conversation_config;
  cc.conversation = cc.conversation || {};
  const beforeDuration = cc.conversation.max_duration_seconds;
  cc.conversation.max_duration_seconds = 7200;

  const toolIds = new Set(cc.agent.prompt.tool_ids || []);
  toolIds.add(recallToolId);
  cc.agent.prompt.tool_ids = Array.from(toolIds);
  delete cc.agent.prompt.tools; // must not send both tools and tool_ids

  await api(`/convai/agents/${AGENT_ID}`, { method: 'PATCH', body: JSON.stringify({ conversation_config: cc }) });
  console.log(`      max_duration_seconds: ${beforeDuration} -> 7200`);
  console.log(`      tool_ids now includes recall_memory: ${recallToolId}`);

  console.log('[5/5] Verifying...');
  const verify = await api(`/convai/agents/${AGENT_ID}`);
  const verifySmTool = await api(`/convai/tools/${SAVE_MEMORY_TOOL_ID}`);
  const ok1 = verify.conversation_config.conversation.max_duration_seconds === 7200;
  const ok2 = verifySmTool.tool_config.api_schema.request_body_schema.properties.userId?.dynamic_variable === 'user_id';
  const ok3 = (verify.conversation_config.agent.prompt.tool_ids || []).includes(recallToolId);
  console.log(`      max_duration_seconds = 7200: ${ok1 ? 'OK' : 'FAILED'}`);
  console.log(`      save_memory userId bound: ${ok2 ? 'OK' : 'FAILED'}`);
  console.log(`      recall_memory tool wired to agent: ${ok3 ? 'OK' : 'FAILED'}`);
  if (!ok1 || !ok2 || !ok3) process.exitCode = 1;
  else console.log('\n✅ All agent-config changes verified live.');
})().catch((e) => { console.error('\n✗ FAILED:', e.message); process.exitCode = 1; });
