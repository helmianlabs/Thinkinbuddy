// helmion-relay.js — the phone half of the Helmion relay.
//
// WHAT THIS IS. Troy talks to Mark on his phone. This is how what he says can
// also reach Helmion on his desktop, and how Helmion can answer back. It is the
// last missing piece: the server half went live on 2026-07-31 (404 -> 401), the
// desktop half was already written and tested, and the phone had no client at
// all.
//
// WHAT IT CANNOT DO, BY DESIGN. It carries TEXT. There is no command, no path,
// no shell string, and nothing here reaches anything that executes. A message
// arriving from this file becomes a line Helmion SHOWS, and that is the whole of
// its authority. The wire format enforces it on the other side too — see
// src/relay/protocol.mjs in the Helmion repo, whose parser drops any frame kind
// it does not recognise rather than forwarding it. Giving Mark the ability to
// actually run things is a separate, deliberate decision with a security review
// attached, and it is not this file.
//
// THE ENDPOINT CONTRACT, read out of api/relay-http.js rather than assumed:
//   GET  ?channel=<c>&role=phone&since=<cursor>   -> { ok, cursor, more, messages[], presence }
//   POST ?channel=<c>&role=phone   body {text}    -> appends one message
//   auth: Authorization: Bearer <secret>, or ?key=<secret>
//   roles are exactly 'phone' and 'desktop'; a channel is [a-z0-9][a-z0-9_-]{1,62}
//   a body is capped at 4000 characters
//
// WHY POLLING AND NOT A SOCKET. The deployed endpoint is the HTTP poller. The
// WebSocket variant needs a dependency this project does not carry, and Vercel
// functions cap at 15s anyway. Polling is unglamorous and it works.

const MAX_BODY_CHARS = 4000;

/** Poll fast while a conversation is live, slow when nothing is happening. */
const ACTIVE_MS = 1500;
const IDLE_MS = 15000;
/** How long after the last message we keep polling fast. */
const ACTIVE_WINDOW_MS = 60000;

export function createHelmionRelay({
  baseUrl,
  secret,
  channel = 'troy',
  onMessage = () => {},
  onPresence = () => {},
  onError = () => {},
}) {
  if (!baseUrl || !secret) {
    // Not an error worth throwing — the app must still run for someone who has
    // not set the relay up. It just does nothing, and says so if asked.
    return {
      enabled: false,
      start() {},
      stop() {},
      async send() { return { ok: false, reason: 'relay not configured' }; },
      isPresent: () => false,
    };
  }

  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/api/relay-http`;
  const headers = { authorization: `Bearer ${secret}` };

  let cursor = 0;
  let timer = null;
  let running = false;
  let lastActivity = 0;
  let desktopPresent = false;

  function url(extra = {}) {
    const u = new URL(endpoint);
    u.searchParams.set('channel', channel);
    u.searchParams.set('role', 'phone');
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async function pullOnce() {
    const res = await fetch(url({ since: cursor }), { headers, cache: 'no-store' });

    if (res.status === 401) throw new Error('relay rejected the key');
    if (res.status === 503) throw new Error('relay database is not set up yet');
    if (!res.ok) throw new Error(`relay returned ${res.status}`);

    const data = await res.json();

    // Trust the server's cursor, not our own arithmetic. It is the only thing
    // that knows what it actually sent.
    if (typeof data.cursor === 'number') cursor = data.cursor;

    const present = Boolean(data?.presence?.desktop?.present);
    if (present !== desktopPresent) {
      desktopPresent = present;
      onPresence(present);
    }

    for (const m of data.messages || []) {
      lastActivity = Date.now();
      onMessage({ from: m.from, body: m.body, at: m.at });
    }

    // `more` means the page was full and there is a backlog. Drain it now rather
    // than waiting for the next tick — a burst must not arrive in slow motion.
    if (data.more) await pullOnce();
  }

  async function tick() {
    if (!running) return;
    try {
      await pullOnce();
    } catch (err) {
      onError(err);
    } finally {
      if (running) {
        const fast = Date.now() - lastActivity < ACTIVE_WINDOW_MS;
        timer = setTimeout(tick, fast ? ACTIVE_MS : IDLE_MS);
      }
    }
  }

  return {
    enabled: true,

    start() {
      if (running) return;
      running = true;
      tick();
    },

    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    /** True when Helmion has polled recently. Lets the UI say so honestly. */
    isPresent: () => desktopPresent,

    /**
     * Send one line to Helmion. Returns a result rather than throwing, because
     * a failed send has to be SHOWN — a message that silently vanishes is the
     * worst outcome here.
     */
    async send(text) {
      const body = String(text ?? '').trim();
      if (!body) return { ok: false, reason: 'nothing to send' };
      if (body.length > MAX_BODY_CHARS) {
        return { ok: false, reason: `too long — ${body.length} of ${MAX_BODY_CHARS} characters` };
      }

      try {
        const res = await fetch(url(), {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          // The field is `body`, not `text`. api/relay-http.js:200 reads
          // payload.value.body and refuses anything that is not a string rather
          // than coercing it — verified by sending the wrong key first, which
          // returned 400 "body must be a string" instead of silently accepting.
          body: JSON.stringify({ body }),
        });

        if (res.status === 401) return { ok: false, reason: 'relay rejected the key' };
        if (res.status === 503) return { ok: false, reason: 'relay database is not set up yet' };
        if (!res.ok) return { ok: false, reason: `relay returned ${res.status}` };

        lastActivity = Date.now();
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err.message };
      }
    },
  };
}
