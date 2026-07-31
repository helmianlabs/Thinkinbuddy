-- helmion_relay — the meeting point for the phone <-> desktop relay.
--
-- TROY-APPROVED: Troy said "go ... yeah go ahead finish building it all out
-- please" on 2026-07-30, in direct answer to being asked for the table and the
-- deploy. Before that he was told exactly what this costs and what it carries.
--
-- WHY A TABLE AT ALL: Vercel does not guarantee that two connections reach the
-- same instance, so the phone and the desktop are usually held by different
-- processes on different machines. An in-process map would silently deliver
-- nothing. The table is the meeting point; the connections are just windows
-- onto it.
--
-- APPEND ONLY. There is deliberately no `delivered` column. Marking a row
-- delivered means writing AFTER the send, and a function that dies in that gap
-- loses the message with no way to know it did. Instead each client remembers
-- the last id it saw and asks for what came after — which makes a reconnect
-- exact, idempotent, and safe to repeat as many times as the network demands.

CREATE TABLE IF NOT EXISTS helmion_relay (
  id          BIGSERIAL   PRIMARY KEY,
  channel     TEXT        NOT NULL,
  sender      TEXT        NOT NULL CHECK (sender IN ('phone', 'desktop')),
  body        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every read is "rows on this channel after this id", so this is the only index
-- that matters, and it serves the ORDER BY as well.
CREATE INDEX IF NOT EXISTS helmion_relay_channel_id ON helmion_relay (channel, id);

-- Presence. The desktop stamps itself here every time it polls, so the phone
-- can tell "Helmion is listening" from "you are talking to nobody" — which is
-- the single most useful thing to know before typing a paragraph into a phone.
CREATE TABLE IF NOT EXISTS helmion_relay_presence (
  channel     TEXT        NOT NULL,
  role        TEXT        NOT NULL CHECK (role IN ('phone', 'desktop')),
  seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT        NOT NULL DEFAULT '',
  PRIMARY KEY (channel, role)
);

-- Housekeeping. The relay is a conversation, not an archive — Helmion's own
-- ledgers are what get kept. Run it whenever, or wire it to a cron.
--   DELETE FROM helmion_relay WHERE created_at < now() - INTERVAL '30 days';
