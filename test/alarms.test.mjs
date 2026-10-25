// test/alarms.test.mjs — phone-powers bite: server-saved alarms actually
// ring on the phone (public/alarms.js + the server/handlers/alarm.js sync
// surface it consumes).
//
// Two layers, matching the house style (cf. onboarding-ui.test.mjs,
// billing.test.mjs):
//   1. Pure-logic tests over public/alarms.js: stable notification-id
//      mapping, schedule-entry computation from the REAL stored alarm
//      shapes, sync diffing, and the full sync engine driven by a fake
//      plugin / fetch / storage (no device, no network).
//   2. Static contract checks: the module parses, onboarding.js wires
//      it, and the server's spoken confirmation never claims "set".
//
// NOT covered here (no device in this environment): a notification
// actually firing on a phone. That stays UNVERIFIED until a native
// build runs this on hardware.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  notificationIdFor,
  resolveAlarmUserId,
  toScheduleEntry,
  phoneActionToEntry,
  planSync,
  confirmationText,
  syncAlarms,
  cancelAlarm,
} from '../public/alarms.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const alarmsJs = readFileSync(new URL('../public/alarms.js', import.meta.url), 'utf8');
const onboardingJs = readFileSync(new URL('../public/onboarding.js', import.meta.url), 'utf8');
const alarmHandler = readFileSync(new URL('../server/handlers/alarm.js', import.meta.url), 'utf8');
const personalityJs = readFileSync(new URL('../lib/personality.js', import.meta.url), 'utf8');

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const future = (ms) => new Date(NOW + ms).toISOString();

// A stored server entry, exactly the shape server/handlers/alarm.js POST
// writes to Blob: { id (Date.now()), userId, title, body, fireAt,
// pending, created }.
const stored = (over = {}) => ({
  id: 1793000000000,
  userId: 'tenant-1',
  title: 'Pick up kids',
  body: 'School gate',
  fireAt: future(3_600_000),
  pending: true,
  created: new Date(NOW).toISOString(),
  ...over,
});

// ─── notificationIdFor ──────────────────────────────────────────────────

test('notificationIdFor: stable, in plugin int range, distinct per alarm', () => {
  const a = notificationIdFor(1793000000000);
  assert.equal(a, notificationIdFor('1793000000000')); // numeric/string agree
  assert.equal(a, notificationIdFor(1793000000000));    // stable across calls
  assert.ok(Number.isInteger(a) && a >= 1 && a <= 2147483647);
  const ids = new Set([1, 2, 3, 1793000000000, 1793000000001, 1793000060000].map(notificationIdFor));
  assert.equal(ids.size, 6);
});

// ─── resolveAlarmUserId ─────────────────────────────────────────────────

test('resolveAlarmUserId mirrors the agent/server fallback order', () => {
  assert.equal(resolveAlarmUserId({ tenantId: 't-1', legacyUserId: 'u-1' }), 't-1');
  assert.equal(resolveAlarmUserId({ tenantId: null, legacyUserId: 'u-1' }), 'u-1');
  assert.equal(resolveAlarmUserId({}), 'troy'); // the server POST default
  assert.equal(resolveAlarmUserId(), 'troy');
});

// ─── toScheduleEntry ────────────────────────────────────────────────────

test('toScheduleEntry normalizes a stored alarm', () => {
  const e = toScheduleEntry(stored());
  assert.equal(e.serverId, '1793000000000');
  assert.equal(e.notifId, notificationIdFor(1793000000000));
  assert.equal(e.fireAtMs, NOW + 3_600_000);
  assert.equal(e.title, 'Pick up kids');
  assert.equal(e.body, 'School gate');
});

test('toScheduleEntry rejects unusable shapes', () => {
  assert.equal(toScheduleEntry(null), null);
  assert.equal(toScheduleEntry({}), null);
  assert.equal(toScheduleEntry(stored({ id: '' })), null);
  assert.equal(toScheduleEntry(stored({ fireAt: 'not a date' })), null);
  assert.equal(toScheduleEntry(stored({ title: '  ', body: 42 })).title, 'Reminder');
  assert.equal(toScheduleEntry(stored({ title: '  ', body: 42 })).body, '');
});

// ─── phoneActionToEntry (the Actionable shape) ─────────────────────────

test('phoneActionToEntry maps reminder + calendar_event, refuses the rest', () => {
  const r = phoneActionToEntry({ kind: 'reminder', title: 'Call the vet', when_iso: future(60_000) }, NOW);
  assert.equal(r.title, 'Call the vet');
  assert.equal(r.fireAtMs, NOW + 60_000);
  assert.equal(r.notifId, notificationIdFor(r.serverId)); // stable synthetic id

  const c = phoneActionToEntry({ kind: 'calendar_event', title: 'Dentist', when_iso: future(120_000) }, NOW);
  assert.equal(c.body, 'Calendar event'); // rings as a notification, never a fake calendar entry

  assert.equal(phoneActionToEntry({ kind: 'none', title: 'x', when_iso: future(60_000) }, NOW), null);
  assert.equal(phoneActionToEntry({ kind: 'reminder', title: 'x', when_iso: '' }, NOW), null);
  assert.equal(phoneActionToEntry({ kind: 'reminder', title: 'x', when_iso: future(-60_000) }, NOW), null);
});

// ─── planSync ───────────────────────────────────────────────────────────

test('planSync: new desired -> schedule; unchanged -> keep; nothing extra cancelled', () => {
  const e = toScheduleEntry(stored());
  let plan = planSync([e], []);
  assert.deepEqual(plan.schedule, [e]);
  assert.deepEqual(plan.cancel, []);

  plan = planSync([e], [{ notifId: e.notifId, serverId: e.serverId, fireAtMs: e.fireAtMs }]);
  assert.deepEqual(plan.schedule, []);
  assert.deepEqual(plan.cancel, []);
  assert.deepEqual(plan.keep, [e.serverId]);
});

test('planSync: changed fireAt reschedules; undesired on-device entry is cancelled', () => {
  const e = toScheduleEntry(stored());
  const moved = { ...e, fireAtMs: e.fireAtMs + 900_000 };
  let plan = planSync([moved], [{ notifId: e.notifId, serverId: e.serverId, fireAtMs: e.fireAtMs }]);
  assert.deepEqual(plan.cancel, [e.notifId]);
  assert.deepEqual(plan.schedule, [moved]);

  plan = planSync([], [{ notifId: e.notifId, serverId: e.serverId, fireAtMs: e.fireAtMs }]);
  assert.deepEqual(plan.cancel, [e.notifId]);
  assert.deepEqual(plan.schedule, []);
});

// ─── confirmationText: the honest-wording contract ─────────────────────

test('confirmationText says "set" only for an on-device schedule', () => {
  const e = toScheduleEntry(stored());
  const setText = confirmationText({ scheduled: true, entry: e });
  assert.match(setText, /set for/);
  assert.match(setText, /Pick up kids/);

  const savedText = confirmationText({ scheduled: false, entry: e });
  assert.match(savedText, /saved for/);
  assert.match(savedText, /app is installed and signed in/);
  assert.ok(!/\bset\b/.test(savedText), `saved wording must not claim "set": ${savedText}`);
});

// ─── syncAlarms with fakes ──────────────────────────────────────────────

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

function fakePlugin({ permission = 'granted' } = {}) {
  const state = { pending: [], scheduledCalls: [], cancelledCalls: [] };
  return {
    state,
    checkPermissions: async () => ({ display: permission }),
    requestPermissions: async () => ({ display: permission }),
    getPending: async () => ({ notifications: state.pending }),
    schedule: async ({ notifications }) => {
      state.scheduledCalls.push(notifications);
      for (const n of notifications) {
        state.pending = state.pending.filter(p => p.id !== n.id);
        state.pending.push({ id: n.id, title: n.title, body: n.body, schedule: { at: n.schedule.at }, extra: n.extra });
      }
      return {};
    },
    cancel: async ({ notifications }) => {
      state.cancelledCalls.push(notifications);
      const ids = new Set(notifications.map(n => n.id));
      state.pending = state.pending.filter(p => !ids.has(p.id));
    },
  };
}

// Fake server: pending list + all list + DELETE recording, matching
// server/handlers/alarm.js response shapes ({ ok, alarms }).
function fakeFetch({ pending = [], all = null } = {}) {
  const calls = { get: [], del: [] };
  const fn = async (url, opts = {}) => {
    const u = String(url);
    if ((opts.method || 'GET') === 'DELETE') {
      calls.del.push(u);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    calls.get.push(u);
    const list = u.includes('all=1') ? (all ?? pending) : pending;
    return { ok: true, status: 200, json: async () => ({ ok: true, alarms: list }) };
  };
  fn.calls = calls;
  return fn;
}

const deps = (over = {}) => ({
  plugin: fakePlugin(),
  fetchFn: fakeFetch(),
  storage: fakeStorage(),
  userId: 'tenant-1',
  nowMs: NOW,
  ...over,
});

test('syncAlarms on plain web (no plugin) claims nothing and fetches nothing', async () => {
  const fetchFn = fakeFetch({ pending: [stored()] });
  const r = await syncAlarms(deps({ plugin: null, fetchFn }));
  assert.deepEqual(r, { available: false });
  assert.equal(fetchFn.calls.get.length, 0);
  assert.equal(fetchFn.calls.del.length, 0);
});

test('syncAlarms schedules future pending alarms and marks them delivered', async () => {
  const a = stored();
  const b = stored({ id: 1793000001000, title: 'Water the plants', fireAt: future(7_200_000) });
  const plugin = fakePlugin();
  const fetchFn = fakeFetch({ pending: [a, b], all: [a, b] });
  const r = await syncAlarms(deps({ plugin, fetchFn }));

  assert.equal(r.available, true);
  assert.equal(r.permission, true);
  assert.deepEqual(r.scheduled.sort(), [String(a.id), String(b.id)].sort());
  assert.equal(plugin.state.pending.length, 2);
  const first = plugin.state.pending.find(n => n.extra.serverId === String(a.id));
  assert.equal(first.id, notificationIdFor(a.id));
  assert.equal(first.schedule.at.getTime(), NOW + 3_600_000);
  assert.equal(first.extra.tbAlarm, 1);
  // Both marked delivered so the server stops handing them out as pending.
  assert.equal(fetchFn.calls.del.length, 2);
  assert.ok(fetchFn.calls.del.every(u => u.includes('userId=tenant-1')));
});

test('syncAlarms never schedules a past-due alarm, but stops it coming back', async () => {
  const late = stored({ fireAt: future(-300_000) });
  const plugin = fakePlugin();
  const fetchFn = fakeFetch({ pending: [late], all: [late] });
  const r = await syncAlarms(deps({ plugin, fetchFn }));
  assert.equal(r.scheduled.length, 0);
  assert.deepEqual(r.expired, [String(late.id)]);
  assert.equal(plugin.state.pending.length, 0);
  assert.equal(fetchFn.calls.del.length, 1); // marked delivered
});

test('syncAlarms second run is a no-op (stable ids, delivered entries stay scheduled)', async () => {
  const a = stored();
  const plugin = fakePlugin();
  const storage = fakeStorage();
  await syncAlarms(deps({ plugin, storage, fetchFn: fakeFetch({ pending: [a], all: [a] }) }));

  // Server now reports it delivered (pending=false), pending list empty.
  const delivered = { ...a, pending: false };
  const r2 = await syncAlarms(deps({
    plugin, storage,
    fetchFn: fakeFetch({ pending: [], all: [delivered] }),
  }));
  assert.equal(r2.scheduled.length, 0);
  assert.equal(r2.cancelled.length, 0);
  assert.equal(plugin.state.pending.length, 1); // still on the device
});

test('syncAlarms cancels an on-device alarm that was deleted server-side', async () => {
  const a = stored();
  const b = stored({ id: 1793000001000, title: 'Water the plants', fireAt: future(7_200_000) });
  const plugin = fakePlugin();
  const storage = fakeStorage();
  await syncAlarms(deps({ plugin, storage, fetchFn: fakeFetch({ pending: [a, b], all: [a, b] }) }));
  assert.equal(plugin.state.pending.length, 2);

  // b's blob is gone server-side: all-list now only carries a (delivered).
  const r = await syncAlarms(deps({
    plugin, storage,
    fetchFn: fakeFetch({ pending: [], all: [{ ...a, pending: false }] }),
  }));
  assert.deepEqual(r.cancelled, [notificationIdFor(b.id)]);
  assert.equal(plugin.state.pending.length, 1);
  assert.equal(plugin.state.pending[0].extra.serverId, String(a.id));
});

test('syncAlarms does not steal an alarm another client already delivered', async () => {
  const a = stored({ pending: false }); // delivered elsewhere
  const plugin = fakePlugin();
  const r = await syncAlarms(deps({ plugin, fetchFn: fakeFetch({ pending: [], all: [a] }) }));
  assert.equal(r.scheduled.length, 0);
  assert.equal(plugin.state.pending.length, 0);
});

test('syncAlarms without notification permission schedules and marks nothing', async () => {
  const a = stored();
  const plugin = fakePlugin({ permission: 'denied' });
  const fetchFn = fakeFetch({ pending: [a], all: [a] });
  const r = await syncAlarms(deps({ plugin, fetchFn }));
  assert.equal(r.permission, false);
  assert.equal(r.scheduled.length, 0);
  assert.equal(plugin.state.pending.length, 0);
  assert.equal(fetchFn.calls.del.length, 0); // stays pending for a later sync
});

test('cancelAlarm cancels on-device and marks the save delivered', async () => {
  const a = stored();
  const plugin = fakePlugin();
  const storage = fakeStorage();
  await syncAlarms(deps({ plugin, storage, fetchFn: fakeFetch({ pending: [a], all: [a] }) }));
  assert.equal(plugin.state.pending.length, 1);

  const fetchFn = fakeFetch();
  const r = await cancelAlarm(a.id, { plugin, fetchFn, storage, userId: 'tenant-1' });
  assert.equal(r.ok, true);
  assert.equal(plugin.state.pending.length, 0);
  assert.equal(fetchFn.calls.del.length, 1);
});

// ─── Static contract ────────────────────────────────────────────────────

test('public/alarms.js parses as a valid ES module (node --check)', () => {
  execFileSync(process.execPath, ['--check', `${root}public/alarms.js`], { stdio: 'pipe' });
});

test('alarms.js drives the real server surface and the real plugin', () => {
  assert.ok(alarmsJs.includes('/api/alarm/pending?userId='));
  assert.ok(alarmsJs.includes('all=1'));
  assert.ok(alarmsJs.includes("window.Capacitor?.Plugins?.LocalNotifications"));
  assert.ok(alarmsJs.includes('requestPermissions'));
  assert.ok(alarmsJs.includes('visibilitychange')); // foreground re-sync
});

test('onboarding.js wires alarm sync after sign-in, at boot, and in legacy mode', () => {
  assert.ok(onboardingJs.includes("import('./alarms.js')"));
  assert.ok(onboardingJs.includes('startAlarmSync'));
  assert.ok(onboardingJs.includes('await wireAlarms();'));
});

test('server confirmation + agent guidance never claim a save is "set"', () => {
  assert.ok(!alarmHandler.includes("I've set a reminder"));
  assert.ok(alarmHandler.includes("reminder saved for"));
  assert.ok(alarmHandler.includes("wantAll")); // ?all=1 deletion-detection surface
  assert.ok(personalityJs.includes('say "saved", never claim it is set on the phone'));
});
