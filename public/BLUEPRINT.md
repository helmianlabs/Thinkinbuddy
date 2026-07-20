# The AI Memory & Voice Blueprint
### Two Systems. Zero Subscriptions. Permanent AI Memory.

---

## What You're Getting

Two completely separate hacks that solve two of the biggest frustrations with AI tools today:

1. **The Shared Memory System** — Give Claude a permanent, searchable memory database so it never forgets what you decided three days ago. Works across Claude Code (terminal) AND Claude.ai (voice/chat). One database. Both AIs read and write to it.

2. **The Voice-to-Structured-Sheets PWA** — Speak into your phone while driving, walking, or working. Claude transcribes, structures, and logs it to Google Sheets automatically. No typing. No cleanup.

---

---

# PRODUCT 1: THE SHARED MEMORY SYSTEM
### Give Your AI a Permanent Brain

---

## The Problem This Solves

Claude has a context window. When a conversation gets long, it forgets what you talked about yesterday. Start a new session and it has total amnesia. Power users hit this wall constantly on long projects.

This system builds an external long-term memory database that lives outside of Claude's context window. You can have a 6-hour session, clear it, start fresh — and Claude can still search and find anything from any prior session.

---

## How It Works

```
Claude Code (terminal)          Claude.ai (voice/chat)
        |                               |
        | search_memory tool            | search_memory tool (MCP connector)
        |                               |
        v                               v
   ┌─────────────────────────────────────┐
   │         Neon PostgreSQL             │
   │         (claude_memory DB)          │
   │                                     │
   │  projects → conversations → messages│
   │  48,000+ rows searchable via ILIKE  │
   └─────────────────────────────────────┘
```

Both Claude instances hit the same database. Claude Code uses a local MCP tool. Claude.ai uses the remote MCP server we deploy to Vercel.

---

## Prerequisites

- A free [Neon](https://neon.tech) account (PostgreSQL database, free tier works)
- A free [Vercel](https://vercel.com) account
- Node.js installed locally
- The `pg` npm package
- An Anthropic API key (for Claude.ai + Claude Code — you already have this)

---

## Step 1: Create the Neon Database

1. Go to [neon.tech](https://neon.tech) → sign up free → create a project
2. In the Neon dashboard, click your project → **Databases** → **New Database**
3. Name it `claude_memory`
4. Copy your connection string from the dashboard. It looks like:
   ```
   postgresql://username:password@ep-something.us-east-2.aws.neon.tech/claude_memory?sslmode=require
   ```
5. Save this URL — you'll need it in multiple places

---

## Step 2: Create the Database Schema

Connect to your Neon database (use the SQL editor in the Neon dashboard, or `psql`):

```sql
-- Projects table (mirrors Claude.ai project structure)
CREATE TABLE IF NOT EXISTS projects (
  uuid TEXT PRIMARY KEY,
  name TEXT,
  raw JSONB
);

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
  uuid TEXT PRIMARY KEY,
  name TEXT,
  project_uuid TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  message_count INT DEFAULT 0
);

-- Messages table (the searchable content)
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_uuid TEXT REFERENCES conversations(uuid),
  turn_index INT DEFAULT 0,
  sender TEXT CHECK (sender IN ('human', 'assistant')),
  text TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for fast ILIKE search
CREATE INDEX IF NOT EXISTS messages_text_idx ON messages USING GIN (to_tsvector('english', text));

-- Index for conversation lookups
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages (conversation_uuid);
```

---

## Step 3: Deploy the MCP Server to Vercel

This is the public HTTPS endpoint that Claude.ai connects to. It exposes two tools:
- `search_memory` — search your database by keyword
- `save_to_memory` — save a summary back to the database

### 3a. Create a new Vercel project (or use an existing one)

```bash
mkdir my-memory-server
cd my-memory-server
npm init -y
npm install pg
```

### 3b. Create `api/mcp.js`

```javascript
// api/mcp.js — MCP Streamable HTTP server for Claude.ai connector

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
    description: "Search the shared Claude memory database. Use this when the user asks about past conversations, prior decisions, or anything from previous sessions.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms (case-insensitive substring match)' },
        limit: { type: 'integer', description: 'Max results (default 10, max 50)', default: 10 }
      },
      required: ['query']
    }
  },
  {
    name: 'save_to_memory',
    description: "Save a summary or note to the shared memory database for future retrieval. Call this at the end of significant conversations or when the user says 'remember this'.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: "Short title (include date, e.g. 'Project kickoff 2026-01-15')" },
        content: { type: 'string', description: 'Text to save — summary, decisions, key points' }
      },
      required: ['title', 'content']
    }
  }
];

async function searchMemory(query, limit = 10) {
  const pool = getPool();
  const { rows } = await pool.query(
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
  if (req.method === 'GET') return res.status(200).json({ ok: true, server: 'claude-memory', tools: ['search_memory', 'save_to_memory'] });
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
    return res.json(err(id, -32603, `Error: ${e?.message}`));
  }
}
```

### 3c. Create `vercel.json`

```json
{
  "functions": {
    "api/mcp.js": { "maxDuration": 30 }
  }
}
```

### 3d. Add the env var and deploy

```bash
# Add your Neon connection string
vercel env add NEON_CLAUDE_MEMORY_URL production
# paste your postgresql://... URL when prompted

# Deploy
vercel --prod
```

Your MCP server is now live at `https://your-project.vercel.app/api/mcp`

---

## Step 4: Wire Claude.ai to Your Memory

1. Go to **claude.ai** → **Settings** → **Capabilities** → **Connectors** → **Add custom connector**
2. Fill in:
   - **Name:** `My Memory`
   - **Remote MCP server URL:** `https://your-project.vercel.app/api/mcp`
3. Click **Add**
4. Toggle it to **Always allow**

Claude.ai now has `search_memory` and `save_to_memory` tools available in every conversation.

---

## Step 5: Create the "Auto Memory" Claude.ai Project

1. In Claude.ai, go to **Projects** → **New Project**
2. Name it whatever you want (e.g. "Auto")
3. Paste these instructions in the project system prompt:

```
You have access to a persistent shared memory database via two tools: search_memory and save_to_memory.

RULES:
1. After the user's first message each session, call search_memory with the most relevant keywords from what they are asking about. Use the results to inform your response.
2. At the end of any significant conversation — or any time the user says "remember this" or "save this" — call save_to_memory with a descriptive title (include today's date) and a detailed summary of key decisions, facts, context, and open questions discussed.
3. Never tell the user you are searching or saving unless they ask. Just do it silently and incorporate the results naturally.
```

4. Start every important session from this project. That's it.

---

## Step 6 (Optional): Load Your Past Claude Code Sessions

If you use Claude Code (the terminal CLI), you can bulk-load your past sessions into the database so they're immediately searchable from Claude.ai.

### Get your existing Claude Code sessions

Claude Code logs all sessions. The connection string trick: Claude Code stores its Neon connection string inside `~/.claude.json`. Extract it and swap the database name:

```javascript
// extract-and-load.mjs
import { readFileSync } from 'fs';
import { Pool } from 'pg';

const raw = readFileSync('/Users/YOU/.claude.json', 'utf8');
const match = raw.match(/postgres(?:ql)?:\/\/[^"'\s\\]+neon\.tech\/neondb[^"'\s\\]*/);
const baseUrl = match[0].replace(/\\u0026/g, '&');
const claudeMemoryUrl = baseUrl.replace(/\/neondb(\?|$)/, '/claude_memory$1');

// Now use claudeMemoryUrl with pg to connect to YOUR claude_memory DB
const pool = new Pool({ connectionString: claudeMemoryUrl, ssl: { rejectUnauthorized: false } });
```

This only works if you're already using Neon for Claude Code's MCP postgres server. If you're not, skip this step — Claude.ai will start building the database forward from your first saved conversation.

---

## How to Use It Day-to-Day

- **Always start sessions from your "Auto" project** — Claude will auto-search relevant history
- **Say "remember this"** at any point and Claude saves a summary
- **Ask "what did we decide about X?"** — Claude searches and tells you
- The database grows every session. Richer over time. Never hits a context limit.

---

---

# PRODUCT 2: VOICE-TO-STRUCTURED-SHEETS PWA
### Talk. Claude Structures It. Google Sheets Catches It.

---

## The Problem This Solves

You're driving. You have a great idea. By the time you get somewhere to type it, it's gone or garbled. Standard voice recorders give you a wall of messy text. This system takes your rambling voice note, sends it through Claude, and drops a clean structured row into Google Sheets automatically.

---

## How It Works

```
Phone microphone
      |
      v
Browser MediaRecorder API (records audio)
      |
      v
/api/diary serverless function (Vercel)
      |
      ├─► OpenAI Whisper API (transcribes audio to text)
      |
      ├─► Claude Haiku (parses text into structured fields)
      |   → date, time, location, category, priority,
      |     summary, detail, action items
      |
      └─► Google Apps Script webhook (appends row to Google Sheet)
```

---

## Prerequisites

- A free [Vercel](https://vercel.com) account
- An [OpenAI API key](https://platform.openai.com) (for Whisper transcription — ~$0.006/minute)
- An [Anthropic API key](https://console.anthropic.com) (for Claude Haiku structuring)
- A Google account (for Sheets)

---

## Step 1: Set Up the Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) → create a new sheet named **"Site Diary"** (or any name you want)
2. Note the Spreadsheet ID from the URL: `https://docs.google.com/spreadsheets/d/THIS_IS_THE_ID/edit`
3. Go to **Extensions** → **Apps Script**
4. Delete the default code and paste this:

```javascript
function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  var ss = SpreadsheetApp.openById('YOUR_SPREADSHEET_ID_HERE');
  var sheet = ss.getActiveSheet();
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Date','Time','Location','Category','Priority','Summary','Detail','Action Items','Transcript']);
  }
  sheet.appendRow(data.row);
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, row: sheet.getLastRow() }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

5. Click **Deploy** → **New deployment** → **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Click Deploy → copy the webhook URL (looks like `https://script.google.com/macros/s/AKfycb.../exec`)

---

## Step 2: Create the Diary API Endpoint

Create `api/diary.js` in your Vercel project:

```javascript
// api/diary.js — Voice note → Whisper → Claude → Google Sheets

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } }
};

async function transcribeAudio(audioBase64, mimeType) {
  const audioBuffer = Buffer.from(audioBase64, 'base64');
  const blob = new Blob([audioBuffer], { type: mimeType });
  const form = new FormData();
  form.append('file', blob, 'audio.webm');
  form.append('model', 'whisper-1');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form
  });
  if (!res.ok) throw new Error(`Whisper error: ${await res.text()}`);
  const data = await res.json();
  return data.text;
}

async function parseWithClaude(transcript) {
  const today = new Date().toISOString().split('T')[0];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Parse this voice note into a structured log entry. Return ONLY valid JSON with these fields:
{
  "date": "YYYY-MM-DD (today is ${today} if not mentioned)",
  "time": "HH:MM or 'unspecified'",
  "location": "location mentioned or 'unspecified'",
  "category": "one of: business-idea / task / reflection / meeting / site-note / general",
  "priority": "high / medium / low",
  "summary": "one crisp sentence, no filler words",
  "detail": "clean prose expansion, remove umms/ahs/repetition",
  "action_items": ["item1", "item2"] or []
}

Voice note: "${transcript}"`
      }]
    })
  });
  if (!res.ok) throw new Error(`Claude error: ${await res.text()}`);
  const data = await res.json();
  const text = data.content[0].text.trim();
  return JSON.parse(text.replace(/```json\n?|\n?```/g, ''));
}

async function logToSheets(parsed, transcript) {
  const webhookUrl = process.env.SHEETS_DIARY_WEBHOOK;
  if (!webhookUrl) return null;
  const row = [
    parsed.date, parsed.time, parsed.location, parsed.category,
    parsed.priority, parsed.summary, parsed.detail,
    (parsed.action_items || []).join('; '), transcript
  ];
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ row })
  });
  return res.ok ? await res.json() : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { text, audioBase64, mimeType } = req.body || {};

    let transcript = text;
    if (!transcript && audioBase64) {
      transcript = await transcribeAudio(audioBase64, mimeType || 'audio/webm');
    }
    if (!transcript) return res.status(400).json({ error: 'No audio or text provided' });

    const parsed = await parseWithClaude(transcript);
    const sheetsResult = await logToSheets(parsed, transcript);

    return res.status(200).json({
      ok: true,
      transcript,
      parsed,
      saved_to_sheets: !!sheetsResult
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
```

---

## Step 3: Create the Mobile Web UI

Create `public/diary.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>Voice Diary</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f0f1a; color: #e0e0e0; font-family: -apple-system, sans-serif; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; }
    h1 { font-size: 1.4rem; margin-bottom: 8px; color: #a78bfa; }
    p.sub { font-size: 0.85rem; color: #666; margin-bottom: 40px; text-align: center; }
    #mic-btn {
      width: 140px; height: 140px; border-radius: 50%; border: none; cursor: pointer;
      background: #4f46e5; color: white; font-size: 3rem;
      box-shadow: 0 0 0 0 rgba(79,70,229,0.4);
      transition: background 0.2s;
    }
    #mic-btn.recording { background: #dc2626; animation: pulse 1s infinite; }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(220,38,38,0.5); } 70% { box-shadow: 0 0 0 20px rgba(220,38,38,0); } 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0); } }
    #status { margin-top: 24px; font-size: 0.9rem; color: #888; min-height: 24px; }
    #result { margin-top: 32px; width: 100%; max-width: 500px; background: #1a1a2e; border-radius: 12px; padding: 20px; display: none; }
    .field { margin-bottom: 12px; }
    .field label { font-size: 0.75rem; color: #666; text-transform: uppercase; letter-spacing: 0.05em; }
    .field p { font-size: 0.95rem; margin-top: 4px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
    .high { background: #450a0a; color: #f87171; }
    .medium { background: #451a03; color: #fb923c; }
    .low { background: #052e16; color: #4ade80; }
    #sheets-status { margin-top: 12px; font-size: 0.8rem; color: #4ade80; }
  </style>
</head>
<body>
  <h1>Voice Diary</h1>
  <p class="sub">Tap the mic. Speak freely. Claude structures it.</p>
  <button id="mic-btn">🎙️</button>
  <div id="status">Tap to record</div>
  <div id="result"></div>

  <script>
    let mediaRecorder, chunks = [], recording = false;
    const btn = document.getElementById('mic-btn');
    const status = document.getElementById('status');
    const result = document.getElementById('result');

    btn.addEventListener('click', async () => {
      if (!recording) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        chunks = [];
        mediaRecorder.ondataavailable = e => chunks.push(e.data);
        mediaRecorder.onstop = sendAudio;
        mediaRecorder.start();
        recording = true;
        btn.classList.add('recording');
        btn.textContent = '⏹️';
        status.textContent = 'Recording... tap to stop';
      } else {
        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach(t => t.stop());
        recording = false;
        btn.classList.remove('recording');
        btn.textContent = '⏳';
        status.textContent = 'Processing...';
      }
    });

    async function sendAudio() {
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      const reader = new FileReader();
      reader.onloadend = async () => {
        const b64 = reader.result.split(',')[1];
        try {
          const res = await fetch('/api/diary', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioBase64: b64, mimeType: mediaRecorder.mimeType || 'audio/webm' })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          showResult(data);
        } catch (err) {
          status.textContent = 'Error: ' + err.message;
          btn.textContent = '🎙️';
        }
      };
      reader.readAsDataURL(blob);
    }

    function showResult(data) {
      const p = data.parsed;
      btn.textContent = '🎙️';
      status.textContent = 'Done ✓';
      result.style.display = 'block';
      result.innerHTML = `
        <div class="field"><label>Date & Time</label><p>${p.date} ${p.time}</p></div>
        <div class="field"><label>Location</label><p>${p.location}</p></div>
        <div class="field"><label>Category</label><p>${p.category} <span class="badge ${p.priority}">${p.priority}</span></p></div>
        <div class="field"><label>Summary</label><p><strong>${p.summary}</strong></p></div>
        <div class="field"><label>Detail</label><p>${p.detail}</p></div>
        ${p.action_items?.length ? `<div class="field"><label>Action Items</label><p>${p.action_items.map(a => '• ' + a).join('<br>')}</p></div>` : ''}
        <div class="field"><label>Transcript</label><p style="color:#666;font-size:0.85rem">${data.transcript}</p></div>
        ${data.saved_to_sheets ? '<div id="sheets-status">✓ Saved to Google Sheets</div>' : ''}
      `;
    }
  </script>
</body>
</html>
```

---

## Step 4: Set Environment Variables and Deploy

```bash
# In your Vercel project directory:
vercel env add ANTHROPIC_API_KEY production
vercel env add OPENAI_API_KEY production
vercel env add SHEETS_DIARY_WEBHOOK production   # your Apps Script URL

vercel --prod
```

Your voice diary is live at `https://your-project.vercel.app/diary.html`

Add it to your phone's home screen (Safari/Chrome → Share → "Add to Home Screen") for true app-like experience.

---

## Customizing for Different Categories

Change the Claude parsing prompt to add your own categories. Examples:

- `"Claude, log a business idea..."` → category: business-idea → saved to your ideas sheet
- `"Claude, log a therapy reflection..."` → category: reflection → saved to your private journal
- `"Claude, site note..."` → category: site-note → saved to your construction log

Use multiple Google Sheets and route by category in the Apps Script.

---

---

# WHAT THIS PACKAGE INCLUDES (Gumroad Listing)

**The AI Memory & Voice Blueprint — $39**

✅ Complete MCP server code (copy-paste ready)  
✅ Google Sheets webhook script (plug-and-play)  
✅ Mobile voice diary UI (works on any phone, no app store)  
✅ Step-by-step setup guide (no jargon)  
✅ Claude.ai project system prompt (exact text)  
✅ Database schema SQL (run once, done)  
✅ All env vars and deployment commands  

**What you need to bring:** A Vercel account (free), a Neon account (free), API keys for Anthropic and OpenAI. Total cost to run: ~$0–5/month depending on usage.

---

# SALES PAGE HEADLINE OPTIONS

> "Stop Letting Your AI Get Dementia. Here's the $0/month Fix."

> "I gave Claude a permanent memory using a free Postgres database and one system prompt. Here's exactly how."

> "Two hacks that fixed the two biggest problems with AI tools. No subscriptions. No app stores. You own the data."

---

*Built and verified 2026-06-27. Both systems live and running.*
