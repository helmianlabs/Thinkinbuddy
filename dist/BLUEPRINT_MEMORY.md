# The AI Memory Blueprint
### Give Claude Permanent Memory — $0/Month

**Stop letting your AI forget everything. One Postgres database. Two AIs read and write to it.**

---

## What This Solves

Claude has a context window. When a conversation gets long, it forgets what you talked about yesterday. Start a new session: total amnesia. Power users hit this wall constantly.

This blueprint builds an external long-term memory database that lives *outside* Claude's context window. Clear the session, start fresh, open a new tab in Claude.ai — it can still search and find anything from any prior session.

**Works with both:**
- Claude Code (terminal) — via the built-in `search_memory` MCP tool
- Claude.ai (browser/voice) — via a custom remote MCP connector you add in Settings → Capabilities

---

## What You Get

- Full MCP server code (`api/mcp.js`) — copy, deploy, done. Exposes `search_memory` and `save_to_memory` tools.
- Database schema SQL — run once, it's permanent. Three tables: `projects`, `conversations`, `messages`.
- Step-by-step Claude.ai connector setup — 3 fields, under 2 minutes
- Claude.ai Project system prompt (exact text to paste) — auto-searches memory on every new conversation
- All env var commands — no guessing, no carriage-return gotchas
- `vercel --prod` deployment walkthrough

**Stack:** Neon (free tier), Vercel (free tier), Claude API  
**Running cost:** ~$0–2/month  
**Time to working:** ~30 minutes

---

## Step 1: Create the Neon Database

1. Go to [neon.tech](https://neon.tech) → sign up free → create a project
2. Dashboard → Databases → New Database → name it `claude_memory`
3. Copy your connection string — it looks like:

```
postgresql://username:password@ep-something.us-east-2.aws.neon.tech/claude_memory?sslmode=require
```

**Critical:** If your URL contains `&channel_binding=require` — remove that part. Keep only `?sslmode=require` at the end. That parameter causes a parse error in the Node.js `pg` driver.

---

## Step 2: Run the Schema SQL

In Neon's SQL editor (Dashboard → SQL Editor), run this once:

```sql
CREATE TABLE IF NOT EXISTS projects (uuid TEXT PRIMARY KEY, name TEXT, raw JSONB);

CREATE TABLE IF NOT EXISTS conversations (
  uuid TEXT PRIMARY KEY,
  name TEXT,
  project_uuid TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  message_count INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_uuid TEXT REFERENCES conversations(uuid),
  turn_index INT DEFAULT 0,
  sender TEXT CHECK (sender IN ('human', 'assistant')),
  text TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_text_idx ON messages USING GIN (to_tsvector('english', text));
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages (conversation_uuid);
```

---

## Step 3: Set Up a Vercel Project

If you don't have one already:

```bash
npm install -g vercel
vercel login
mkdir my-mcp-server && cd my-mcp-server
npm init -y
npm install pg
```

Create `package.json` with `"type": "module"` (ES module syntax):

```json
{
  "name": "my-mcp-server",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "build": "echo ok" },
  "dependencies": { "pg": "^8.11.0" }
}
```

Create a `vercel.json`:

```json
{
  "functions": {
    "api/mcp.js": { "maxDuration": 30 }
  }
}
```

---

## Step 4: Create api/mcp.js

Create a folder called `api/` and put this file inside it:

```javascript
import { Pool } from 'pg';

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } }
};

let _pool = null;
function getPool() {
  if (!_pool) {
    const url = process.env.NEON_CLAUDE_MEMORY_URL;
    if (!url) throw new Error('NEON_CLAUDE_MEMORY_URL not set');
    _pool = new Pool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: false }
    });
  }
  return _pool;
}

const TOOLS = [
  {
    name: 'search_memory',
    description: "Search the shared Claude memory database. Use when the user asks about past conversations, prior decisions, or previous sessions.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms (case-insensitive substring match)' },
        limit: { type: 'integer', description: 'Max results — default 10, max 50', default: 10 }
      },
      required: ['query']
    }
  },
  {
    name: 'save_to_memory',
    description: "Save a summary or note to the shared memory database. Call at end of significant conversations or when user says 'remember this'.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: "Short title (e.g. 'Project discussion 2026-06-28')" },
        content: { type: 'string', description: 'Text to save — summary, decision, key points' }
      },
      required: ['title', 'content']
    }
  }
];

async function searchMemory(query, limit = 10) {
  const { rows } = await getPool().query(
    `SELECT m.text, m.sender, m.created_at, c.name AS conversation_name
     FROM messages m
     LEFT JOIN conversations c ON c.uuid = m.conversation_uuid
     WHERE m.text ILIKE $1
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [`%${query}%`, Math.min(Number(limit) || 10, 50)]
  );
  return rows;
}

async function saveToMemory(title, content) {
  const pool = getPool();
  const convUuid = `saved-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `INSERT INTO conversations (uuid, name, created_at, updated_at, message_count)
     VALUES ($1, $2, now(), now(), 1)`,
    [convUuid, title.slice(0, 200)]
  );
  await pool.query(
    `INSERT INTO messages (conversation_uuid, turn_index, sender, text, created_at)
     VALUES ($1, 0, 'assistant', $2, now())`,
    [convUuid, content]
  );
  return convUuid;
}

function ok(id, result) { return { jsonrpc: '2.0', id, result }; }
function err(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, server: 'claude-memory', tools: ['search_memory', 'save_to_memory'] });
  }
  if (req.method !== 'POST') return res.status(405).end();

  const { method, params, id } = req.body || {};
  if (!req.body?.jsonrpc) return res.status(400).json({ error: 'Expected JSON-RPC 2.0' });

  try {
    switch (method) {
      case 'initialize':
        return res.json(ok(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'claude-memory', version: '1.0.0' }
        }));
      case 'notifications/initialized': return res.status(202).end();
      case 'ping': return res.json(ok(id, {}));
      case 'tools/list': return res.json(ok(id, { tools: TOOLS }));
      case 'tools/call': {
        const toolName = params?.name;
        const args = params?.arguments || {};

        if (toolName === 'search_memory') {
          if (!args.query) return res.json(err(id, -32602, 'Missing: query'));
          const rows = await searchMemory(args.query, args.limit);
          const text = rows.length === 0
            ? `No results for: "${args.query}"`
            : `Found ${rows.length} result(s) for "${args.query}":\n\n` +
              rows.map((r, i) =>
                `[${i + 1}] ${(r.sender || '?').toUpperCase()} — "${r.conversation_name || 'unnamed'}" (${r.created_at ? new Date(r.created_at).toLocaleDateString() : '?'})\n${(r.text || '').slice(0, 400)}`
              ).join('\n\n---\n\n');
          return res.json(ok(id, { content: [{ type: 'text', text }], isError: false }));
        }

        if (toolName === 'save_to_memory') {
          if (!args.title || !args.content) return res.json(err(id, -32602, 'Missing: title and content'));
          const uuid = await saveToMemory(args.title, args.content);
          return res.json(ok(id, { content: [{ type: 'text', text: `Saved: "${args.title}" (${uuid})` }], isError: false }));
        }

        return res.json(err(id, -32601, `Unknown tool: ${toolName}`));
      }
      default: return res.json(err(id, -32601, `Method not found: ${method}`));
    }
  } catch (e) {
    if (id !== undefined) return res.json(err(id, -32603, `Error: ${e?.message}`));
    return res.status(500).json({ error: e?.message });
  }
}
```

---

## Step 5: Add Env Var and Deploy

```bash
# Add your Neon connection string — use Bash (not PowerShell echo, which adds \r)
printf 'postgresql://user:pass@ep-xxx.neon.tech/claude_memory?sslmode=require' | vercel env add NEON_CLAUDE_MEMORY_URL production

# Deploy
vercel --prod
```

Your MCP server is now live at: `https://your-project.vercel.app/api/mcp`

---

## Step 6: Wire Claude.ai

1. Go to claude.ai → Settings → Capabilities → Connectors
2. Click **Add custom connector**
3. Fill in:
   - **Name:** `My Memory`
   - **Remote MCP server URL:** `https://your-project.vercel.app/api/mcp`
   - (Leave OAuth fields blank)
4. Click Save → toggle to **Always allow**

Claude.ai will immediately call `tools/list` and discover `search_memory` and `save_to_memory`.

---

## Step 7: Create a Claude.ai Project for Auto-Search

This makes Claude automatically search your memory at the start of every new conversation.

1. claude.ai → Projects → New Project → name it `Auto`
2. Paste this as the **Project instructions:**

```
You have access to a persistent shared memory database via two tools: search_memory and save_to_memory.

RULES:
1. After the user's first message each session, call search_memory with the most relevant keywords from what they are asking about. Use the results to inform your response.
2. At the end of any significant conversation — or any time the user says "remember this" or "save this" — call save_to_memory with a descriptive title (include today's date) and a detailed summary of key decisions, facts, context, and open questions discussed.
3. Never tell the user you are searching or saving unless they ask. Just do it silently and incorporate the results naturally.
```

---

## What It Looks Like When Working

You start a new Claude.ai conversation inside your "Auto" project. You say:

> "What did we decide about the database schema last week?"

Claude silently calls `search_memory("database schema")`, gets back matching rows, and answers with the actual context from your prior sessions — no copy-pasting, no re-explaining.

When the conversation ends and something important was decided, Claude silently calls `save_to_memory("Database schema decision 2026-06-28", "We decided to use UUIDs for all primary keys because...")`.

Next session: it finds that note.

---

## Troubleshooting

**"getaddrinfo ENOTFOUND base"** — Your Neon URL has `channel_binding=require` in it. Strip that out, re-add the env var via `printf` (not `echo`), redeploy.

**"NEON_CLAUDE_MEMORY_URL not set"** — The env var wasn't deployed. Run `vercel env ls` to confirm it exists for Production, then `vercel --prod` to redeploy.

**Claude.ai says "could not connect"** — Make sure your deployed URL returns `{"ok":true}` on a GET request. Test: open `https://your-project.vercel.app/api/mcp` in a browser tab.

**Claude isn't auto-searching** — Make sure you're in the Project that has the system prompt. Regular Claude.ai conversations outside a Project don't use Project instructions.

---

## You Now Own This

The database is yours — on Neon's free tier. The server is yours — on Vercel's free tier. You're not paying a subscription to some memory-as-a-service product. Your data never goes through a third party. The whole thing is ~150 lines of code you can read and modify.
