// api/mcp.js — MCP Streamable HTTP server exposing search_memory over claude_memory Neon DB.
// Claude.ai connects to https://jarvis-troy.vercel.app/api/mcp as a remote MCP server.
// Add Authorization: Bearer <MCP_SECRET> in Claude.ai custom headers.

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
    name: 'push_to_scribe',
    description: "Create a new Google Doc in Troy's Google Drive and save content into it. Call this when Troy says 'Push to Scribe' or asks to save something to Google Drive. The doc is created immediately and the URL is returned.",
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: "Title for the Google Doc (e.g. '2026-06-28 - Voice Draft')"
        },
        content: {
          type: 'string',
          description: 'The full text content to save into the Google Doc'
        }
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'search_memory',
    description: "Search Troy's shared Claude memory database. Contains notes, facts, and context from past Claude Code sessions and saved conversations. Use this when Troy asks about past conversations, prior decisions, project history, Caldmere game dev notes, DairyForge work, or anything he has mentioned before.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search terms (case-insensitive substring match over message text)'
        },
        limit: {
          type: 'integer',
          description: 'Max results to return — default 10, max 50',
          default: 10
        }
      },
      required: ['query']
    }
  },
  {
    name: 'save_to_memory',
    description: "Save a summary or note to Troy's shared memory database so it can be found in future sessions. Call this at the end of significant conversations, or any time Troy says 'remember this' or 'save this'. Content saved here is searchable via search_memory.",
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: "Short title for this memory (e.g. 'Caldmere race design discussion 2026-06-28')"
        },
        content: {
          type: 'string',
          description: 'The text to save — a summary, decision, note, or key points from the conversation'
        }
      },
      required: ['title', 'content']
    }
  }
];

async function pushToScribe(title, content) {
  const webhookUrl = process.env.SCRIBE_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('SCRIBE_WEBHOOK_URL env var not set — deploy the Google Apps Script first');
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content })
  });
  if (!res.ok) throw new Error(`Apps Script error: ${await res.text()}`);
  const data = await res.json();
  return data;
}

async function searchMemory(query, limit = 10) {
  const pool = getPool();
  const safeLimit = Math.min(Number(limit) || 10, 50);
  const { rows } = await pool.query(
    `SELECT m.text, m.sender, m.created_at, c.name AS conversation_name
     FROM messages m
     LEFT JOIN conversations c ON c.uuid = m.conversation_uuid
     WHERE m.text ILIKE $1
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [`%${query}%`, safeLimit]
  );
  return rows;
}

async function saveToMemory(title, content) {
  const pool = getPool();
  const convUuid = `claudeai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function mcpErr(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, server: 'claude-memory-search', version: '1.0.0', tools: ['search_memory'] });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;
  if (!body || body.jsonrpc !== '2.0') {
    return res.status(400).json({ error: 'Expected JSON-RPC 2.0 request' });
  }

  const { method, params, id } = body;

  try {
    switch (method) {
      case 'initialize':
        return res.json(ok(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'claude-memory-search', version: '1.0.0' }
        }));

      case 'notifications/initialized':
        return res.status(202).end();

      case 'ping':
        return res.json(ok(id, {}));

      case 'tools/list':
        return res.json(ok(id, { tools: TOOLS }));

      case 'tools/call': {
        const toolName = params?.name;
        const args = params?.arguments || {};

        if (toolName === 'push_to_scribe') {
          if (!args.title || !args.content) {
            return res.json(mcpErr(id, -32602, 'Missing required arguments: title and content'));
          }
          const result = await pushToScribe(args.title, args.content);
          const docUrl = result.url || 'URL not returned';
          return res.json(ok(id, {
            content: [{ type: 'text', text: `Saved to Google Drive: "${args.title}"\nURL: ${docUrl}` }],
            isError: false
          }));
        }

        if (toolName === 'search_memory') {
          if (!args.query || typeof args.query !== 'string') {
            return res.json(mcpErr(id, -32602, 'Missing required argument: query'));
          }
          const rows = await searchMemory(args.query, args.limit);
          const text = rows.length === 0
            ? `No results in Claude memory for: "${args.query}"`
            : `Found ${rows.length} result(s) for "${args.query}":\n\n` +
              rows.map((r, i) =>
                `[${i + 1}] ${(r.sender || 'unknown').toUpperCase()} — "${r.conversation_name || 'unnamed'}" (${r.created_at ? new Date(r.created_at).toLocaleDateString() : '?'})\n${(r.text || '').slice(0, 400)}`
              ).join('\n\n---\n\n');
          return res.json(ok(id, { content: [{ type: 'text', text }], isError: false }));
        }

        if (toolName === 'save_to_memory') {
          if (!args.title || !args.content) {
            return res.json(mcpErr(id, -32602, 'Missing required arguments: title and content'));
          }
          const convUuid = await saveToMemory(args.title, args.content);
          return res.json(ok(id, {
            content: [{ type: 'text', text: `Saved to memory: "${args.title}" (id: ${convUuid})` }],
            isError: false
          }));
        }

        return res.json(mcpErr(id, -32601, `Unknown tool: ${toolName}`));
      }

      default:
        return res.json(mcpErr(id, -32601, `Method not found: ${method}`));
    }
  } catch (e) {
    console.error('[mcp]', e?.message || e);
    if (id !== undefined) {
      return res.json(mcpErr(id, -32603, `Internal error: ${e?.message || String(e)}`));
    }
    return res.status(500).json({ error: e?.message || 'internal error' });
  }
}
