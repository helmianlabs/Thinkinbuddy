// relay-proxy.js — the phone's door to the Helmion relay, without the key.
//
// WHY THIS EXISTS. The obvious shortcut was to put the relay URL and key
// straight into index.html so the buddy simply has it. That would have worked
// and it would have published a live credential on a public page: anyone who
// viewed source could send text to Troy's Helmion. Refused, and correctly.
//
// So the key stays on the server. The browser calls its own origin with no
// secret at all, and this function attaches the credential and forwards. Same
// two operations, same shapes, one fewer thing to leak.
//
//   GET  /api/relay-proxy?since=<cursor>   -> { cursor, messages[], presence }
//   POST /api/relay-proxy  { body: "..." } -> queued for the desktop
//
// The channel and role are fixed here rather than taken from the caller. A
// browser that could name its own role could claim to be the desktop, and the
// relay decides who sent a message from the ROLE, not from the payload.

const RELAY_URL =
  process.env.HELMION_RELAY_URL || 'https://thinkinbuddy.vercel.app/api/relay-http';
const CHANNEL = process.env.HELMION_RELAY_CHANNEL || 'troy';
const ROLE = 'phone';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');

  const secret = process.env.HELMION_RELAY_SECRET || process.env.MCP_SECRET;
  if (!secret) {
    // Says which variable is missing. A 500 with no name is a 20-minute hunt.
    res.status(503).json({ error: 'HELMION_RELAY_SECRET is not set on the server' });
    return;
  }

  const url = new URL(RELAY_URL);
  url.searchParams.set('channel', CHANNEL);
  url.searchParams.set('role', ROLE);

  try {
    if (req.method === 'GET') {
      const since = Number(req.query?.since);
      url.searchParams.set('since', Number.isSafeInteger(since) && since >= 0 ? String(since) : '0');

      const r = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
      const text = await r.text();
      res.status(r.status).setHeader('content-type', 'application/json').send(text);
      return;
    }

    if (req.method === 'POST') {
      // Only the message text is forwarded. Nothing else the caller sends is
      // passed on, so a payload cannot smuggle a role or a channel through.
      const body =
        typeof req.body === 'string'
          ? (() => { try { return JSON.parse(req.body)?.body; } catch { return undefined; } })()
          : req.body?.body;

      if (typeof body !== 'string' || !body.trim()) {
        res.status(400).json({ error: 'body must be a non-empty string' });
        return;
      }

      const r = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      const text = await r.text();
      res.status(r.status).setHeader('content-type', 'application/json').send(text);
      return;
    }

    res.status(405).json({ error: 'relay-proxy accepts GET and POST' });
  } catch (err) {
    res.status(502).json({ error: `relay unreachable: ${err.message}` });
  }
}
