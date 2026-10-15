// api/relay-http.js — the ALWAYS-ON half of the relay, and the cheap one.
//
// WHY THIS EXISTS AND THE WEBSOCKET IS OPTIONAL. Vercel bills Fluid compute on
// Provisioned Memory for the whole life of an instance, and only pauses CPU
// billing during I/O: "Vercel bills Active CPU only while your code is actually
// running. If the request is waiting on I/O, CPU billing pauses but memory
// billing continues." (https://vercel.com/docs/functions/usage-and-pricing)
//
// A held-open WebSocket is therefore almost free on CPU and expensive on memory:
// this project is Standard (2 GB) in iad1, so one socket open around the clock
// reserves 2 GB x 24h = 48 GB-hrs a day against a Hobby allowance of 360
// GB-hrs a month. That is the whole month gone in about seven and a half days,
// on a plan shared with the live ThinkinBuddy app.
//
// Short polling costs a rounding error by comparison — an instance lives for
// the length of one small query — so THIS is the default and the socket is
// something you switch on for a live back-and-forth.
//
// It carries TEXT. No command kind, no path, no shell string. Nothing here runs
// anything, and the desktop treats what arrives as a line to show.

import crypto from 'node:crypto';
import { Pool } from 'pg';

export const config = { maxDuration: 15 };

const ROLES = ['phone', 'desktop'];
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const MAX_BODY_CHARS = 4000;
const PAGE_LIMIT = 200;

// How long since a stamp before we stop calling the other end present. Three
// missed 30s polls — one missed poll is a hiccup, three is gone.
const PRESENCE_WINDOW_SECONDS = 95;

// WHICH DATABASE, AND WHY THE ORDER CHANGED (2026-07-31).
//
// This read DATABASE_URL_MEMORY first. That variable was set 58 days ago and
// points at a database that is not the one this project actually uses now: after
// creating helmion_relay and helmion_relay_presence in `claude_memory` — the
// database api/mcp.js talks to and the one claude-memory-api's own DATABASE_URL
// reaches — this endpoint still answered "the relay tables do not exist yet".
// The tables were real; the endpoint was looking somewhere else.
//
// NEON_CLAUDE_MEMORY_URL is the live one (set 33 days ago, and what the working
// memory vault uses), so it goes first. The old name stays as a fallback so an
// environment that only has it keeps working — this is additive, not a swap.
const DB_URL =
  process.env.NEON_CLAUDE_MEMORY_URL ||
  process.env.DATABASE_URL_MEMORY ||
  process.env.DATABASE_URL;

let _pool = null;
function getPool() {
  if (!_pool) {
    if (!DB_URL) throw new Error('DATABASE_URL_MEMORY (or DATABASE_URL) not set');
    _pool = new Pool({
      connectionString: DB_URL,
      max: 3,
      idleTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: false },
    });
  }
  return _pool;
}

// Constant time. A plain === on a secret leaks its length and prefix to anyone
// patient enough to time the responses, and this endpoint is on the open
// internet.
// ITS OWN SECRET, FALLING BACK TO THE OLD ONE. MCP_SECRET guards api/mcp.js,
// which Claude.ai is connected to right now as a remote MCP server. Sharing one
// value between the two means the relay cannot be re-keyed without breaking that
// connector, and a leak of either is a leak of both. HELMION_RELAY_SECRET is
// therefore preferred; MCP_SECRET remains the fallback so nothing that works
// today stops working, and so this file behaves identically until the new
// variable is actually set.
function secretMatches(given) {
  const expected = process.env.HELMION_RELAY_SECRET || process.env.MCP_SECRET;
  if (!expected || typeof given !== 'string' || given.length === 0) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false; // timingSafeEqual throws on a length mismatch
  return crypto.timingSafeEqual(a, b);
}

function credentials(req, url) {
  const header = req.headers.authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  return bearer ? bearer[1].trim() : url.searchParams.get('key');
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'relay.local'}`);
  } catch {
    res.status(400).json({ error: 'bad request' });
    return;
  }

  // AUTH BEFORE ANYTHING IS READ. Not just to refuse the caller — doing the
  // work first and rejecting after would let response timing reveal whether a
  // channel exists.
  if (!secretMatches(credentials(req, url))) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const channel = url.searchParams.get('channel');
  const role = url.searchParams.get('role');
  if (!CHANNEL_RE.test(String(channel)) || !ROLES.includes(role)) {
    res.status(400).json({ error: 'bad channel or role' });
    return;
  }

  let pool;
  try {
    pool = getPool();
  } catch (err) {
    res.status(503).json({ error: `relay store unavailable: ${err.message}` });
    return;
  }

  try {
    if (req.method === 'GET') { await pull(pool, res, { channel, role, url }); return; }
    if (req.method === 'POST') { await push(pool, req, res, { channel, role }); return; }
    // Read and write are the only two verbs this relay has. Everything else is
    // refused by name rather than falling through to a default.
    res.status(405).json({ error: 'relay accepts GET (pull) and POST (send)' });
  } catch (err) {
    const missing = /relation .*helmion_relay.* does not exist/i.test(err.message);
    res.status(missing ? 503 : 500).json({
      error: missing
        ? 'the relay tables do not exist yet — run sql/relay.sql against this database'
        : `relay store error: ${err.message}`,
    });
  }
}

async function pull(pool, res, { channel, role, url }) {
  const sinceRaw = Number(url.searchParams.get('since'));
  const since = Number.isSafeInteger(sinceRaw) && sinceRaw >= 0 ? sinceRaw : 0;
  const fresh = since === 0;

  // I AM HERE. Stamped on every poll, so the other end can tell "Helmion is
  // listening" from "you are typing into the void" — which is the single most
  // useful thing to know before thumbing a paragraph into a phone.
  await pool.query(
    `INSERT INTO helmion_relay_presence (channel, role, seen_at)
     VALUES ($1, $2, now())
     ON CONFLICT (channel, role) DO UPDATE SET seen_at = now()`,
    [channel, role],
  );

  // A FRESH CLIENT STARTS AT NOW. since=0 means "I have never polled", and
  // replaying every line ever said at a phone that just woke up is not a
  // feature. A returning client sends the last id it actually saw and gets
  // exactly the gap.
  let messages = [];
  let cursor = since;
  if (fresh) {
    const head = await pool.query('SELECT COALESCE(MAX(id), 0) AS id FROM helmion_relay WHERE channel = $1', [channel]);
    cursor = Number(head.rows[0].id);
  } else {
    const { rows } = await pool.query(
      `SELECT id, sender, body, created_at
         FROM helmion_relay
        WHERE channel = $1 AND id > $2 AND sender <> $3
        ORDER BY id
        LIMIT $4`,
      [channel, since, role, PAGE_LIMIT],
    );
    messages = rows.map((r) => ({
      id: Number(r.id),
      from: r.sender,
      body: r.body,
      at: new Date(r.created_at).toISOString(),
    }));
    if (messages.length) cursor = messages[messages.length - 1].id;
  }

  const others = await pool.query(
    `SELECT role, seen_at, EXTRACT(EPOCH FROM (now() - seen_at)) AS ago
       FROM helmion_relay_presence
      WHERE channel = $1 AND role <> $2`,
    [channel, role],
  );
  const presence = {};
  for (const row of others.rows) {
    presence[row.role] = {
      present: Number(row.ago) <= PRESENCE_WINDOW_SECONDS,
      secondsAgo: Math.round(Number(row.ago)),
    };
  }

  res.status(200).json({
    ok: true,
    channel,
    role,
    cursor,
    // Truncated is not the same as empty. A client that reads `messages` and
    // stops would silently lose the rest of a burst without this.
    more: messages.length === PAGE_LIMIT,
    messages,
    presence,
  });
}

async function push(pool, req, res, { channel, role }) {
  const payload = await readJson(req);
  if (!payload.ok) { res.status(400).json({ error: payload.reason }); return; }

  const body = payload.value?.body;
  // A non-string body is refused, never coerced. String({}) is "[object
  // Object]", and coercing here is how nonsense becomes a permanent line in a
  // transcript.
  if (typeof body !== 'string') { res.status(400).json({ error: 'body must be a string' }); return; }
  if (!body.trim()) { res.status(400).json({ error: 'body is empty' }); return; }
  if (body.length > MAX_BODY_CHARS) {
    res.status(413).json({ error: `body is ${body.length} chars, over the ${MAX_BODY_CHARS} limit` });
    return;
  }

  // The sender is taken from the AUTHENTICATED REQUEST, never from the payload.
  // A caller that labels itself the other role does not get to impersonate it.
  const { rows } = await pool.query(
    'INSERT INTO helmion_relay (channel, sender, body) VALUES ($1, $2, $3) RETURNING id, created_at',
    [channel, role, body],
  );
  res.status(200).json({
    ok: true,
    id: Number(rows[0].id),
    at: new Date(rows[0].created_at).toISOString(),
  });
}

function readJson(req) {
  // Vercel's Node runtime usually parses this already; when it has not, read it
  // ourselves with a hard cap so a large body cannot be streamed at us.
  if (req.body && typeof req.body === 'object') return Promise.resolve({ ok: true, value: req.body });
  if (typeof req.body === 'string') {
    try { return Promise.resolve({ ok: true, value: JSON.parse(req.body) }); } catch { return Promise.resolve({ ok: false, reason: 'not JSON' }); }
  }
  return new Promise((resolve) => {
    let text = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      text += chunk;
      if (text.length > 64 * 1024) { tooBig = true; resolve({ ok: false, reason: 'body too large' }); }
    });
    req.on('end', () => {
      if (tooBig) return;
      try { resolve({ ok: true, value: JSON.parse(text || '{}') }); } catch { resolve({ ok: false, reason: 'not JSON' }); }
    });
    req.on('error', () => resolve({ ok: false, reason: 'could not read the body' }));
  });
}
