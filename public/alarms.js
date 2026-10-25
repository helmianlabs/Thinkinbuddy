// public/alarms.js — ThinkinBuddy client alarm / reminder scheduling.
//
// PLAIN ES module, no build step, loaded by public/onboarding.js via a
// dynamic import (same pattern as ./billing.js).
//
// ─── The two-step handshake this completes ─────────────────────────────
// Mark (the ElevenLabs agent) cannot touch the phone. When the user says
// "remind me", the agent's tool call lands on the SERVER, which only
// SAVES the alarm (server/handlers/alarm.js, Vercel Blob):
//
//   POST   /api/alarm                          -> save { id, userId, title,
//                                                 body, fireAt, pending }
//   GET    /api/alarm/pending?userId=...       -> entries still pending
//   GET    /api/alarm/pending?userId=...&all=1 -> every saved entry
//   DELETE /api/alarm?id=...&userId=...        -> mark delivered (pending
//                                                 = false; NOT a delete)
//
// This module is step 2, the half that was never built: it polls the
// saved alarms for the signed-in user and schedules them on THIS device
// with the Capacitor LocalNotifications plugin, so they actually ring.
//
// Alarms and reminders are ONE shape server-side (the alarm entry above;
// "alarm" vs "reminder" is only wording in the title). Actionable
// capture produces a second, related shape — phoneActions in the
// /api/actionable response ({ kind: 'reminder'|'calendar_event', title,
// when_iso }) — which schedulePhoneAction() below maps onto the same
// on-device scheduling. There is no third shape.
//
// ─── Identity ───────────────────────────────────────────────────────────
// The server keys alarms by the userId the agent sent, which in hosted
// mode is the tenant UUID (the widget's user_id dynamic variable — see
// tbCallUserId() in index.html) and in legacy mode the local user id,
// defaulting to 'troy' when the tool sent none. resolveAlarmUserId()
// mirrors that fallback order exactly, so the client asks for the same
// bucket the agent wrote to.
//
// ─── Sync model (why the local record exists) ──────────────────────────
// The server has no "list my alarms" UI and no true delete: DELETE only
// marks an entry delivered so it stops being handed out as pending. So
// this device keeps its own record (localStorage, per user) of what it
// has scheduled: serverId -> { notifId, fireAt }. Each sync:
//
//   1. Fetch pending (new saves) AND the all-list (every saved entry).
//   2. Desired = future entries this device scheduled before (still in
//      the all-list) + future pending entries nobody has delivered yet.
//      A pending entry this device already scheduled just gets its
//      mark-delivered retried. An entry another client already marked
//      delivered is NOT scheduled here (first device wins — that is the
//      handshake's existing contract).
//   3. A locally recorded entry MISSING from the all-list was deleted
//      server-side -> cancel it on this device. (If the all-list fetch
//      fails, deletion detection is skipped for that sync — cancelling
//      on a guess would be worse.)
//   4. Past-due entries are never scheduled; pending ones are marked
//      delivered so they stop coming back.
//   5. Diff desired vs the plugin's pending notifications (stable ids,
//      see notificationIdFor) and schedule/cancel the difference.
//
// ─── Honest wording ─────────────────────────────────────────────────────
// A reminder may be called "set" only when it was actually scheduled on
// this device. confirmationText() is the wording contract: scheduled ->
// "set"; anything else (plain web, no permission, not yet picked up) ->
// "saved … it'll ring on the phone where the ThinkinBuddy app is
// installed and signed in". On plain web there is no plugin and this
// module no-ops with { available: false } — it never claims a ring.

const RECORD_KEY = 'tb_alarm_sync_v1';
const DEFAULT_POLL_MS = 60_000;

// ─── Plugin access (native shell only) ─────────────────────────────────

function localNotificationsPlugin() {
  if (typeof window === 'undefined') return null;
  return window.Capacitor?.Plugins?.LocalNotifications || null;
}

// ─── Pure logic (unit-tested in test/alarms.test.mjs) ───────────────────

/**
 * Stable LocalNotifications id for a server alarm id. The plugin wants a
 * 32-bit int; server ids are Date.now() millisecond timestamps, far too
 * big, so hash the string form (FNV-1a) into [1, 2^31 - 2]. Stable
 * across syncs, so re-syncing an unchanged alarm is a no-op instead of
 * a duplicate, and a changed fireAt is detected by value, not by id.
 */
export function notificationIdFor(serverId) {
  const s = `tb-alarm:${String(serverId)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 1 + ((h >>> 0) % 2147483646);
}

/** The userId bucket to poll — mirrors the agent/server fallback order. */
export function resolveAlarmUserId({ tenantId, legacyUserId } = {}) {
  return tenantId || legacyUserId || 'troy';
}

/**
 * Validate + normalize one server alarm entry:
 * { id, title, body, fireAt } -> { serverId, notifId, fireAtMs, title,
 * body } or null when the shape or the timestamp is unusable.
 */
export function toScheduleEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.id === undefined || raw.id === null || raw.id === '') return null;
  const fireAtMs = Date.parse(raw.fireAt);
  if (!Number.isFinite(fireAtMs)) return null;
  const serverId = String(raw.id);
  return {
    serverId,
    notifId: notificationIdFor(serverId),
    fireAtMs,
    title: (typeof raw.title === 'string' && raw.title.trim()) ? raw.title.slice(0, 100) : 'Reminder',
    body: typeof raw.body === 'string' ? raw.body.slice(0, 500) : '',
  };
}

/**
 * Map an Actionable phone_action ({ kind, title, when_iso }) onto the
 * same schedule-entry shape. kind 'none', a missing/unparseable time,
 * or a time already past -> null (Actionable's own rule: no time, no
 * phone action). A calendar_event rings as a notification at its start
 * — there is no calendar plugin in this app, and this never pretends
 * otherwise.
 */
export function phoneActionToEntry(action, nowMs = Date.now()) {
  if (!action || typeof action !== 'object') return null;
  if (action.kind !== 'reminder' && action.kind !== 'calendar_event') return null;
  const fireAtMs = Date.parse(action.when_iso);
  if (!Number.isFinite(fireAtMs) || fireAtMs <= nowMs) return null;
  const title = (typeof action.title === 'string' && action.title.trim())
    ? action.title.slice(0, 100) : 'Reminder';
  // Synthetic stable id: same action re-sent -> same notification id.
  const serverId = `pa:${action.when_iso}:${title}`;
  return {
    serverId,
    notifId: notificationIdFor(serverId),
    fireAtMs,
    title,
    body: action.kind === 'calendar_event' ? 'Calendar event' : '',
  };
}

/**
 * Diff desired schedule entries against what the plugin currently has
 * pending. onDevice entries: { notifId, serverId, fireAtMs } — only OUR
 * notifications (callers filter by extra.serverId); foreign pending
 * notifications are never touched.
 * Returns { schedule, cancel, keep }:
 *   schedule — desired entries not on device, or whose fireAt changed
 *   cancel   — notification ids to cancel (stale, deleted, or replaced)
 *   keep     — serverIds already scheduled exactly as desired
 */
export function planSync(desired, onDevice) {
  const desiredById = new Map(desired.map(e => [e.notifId, e]));
  const deviceById = new Map(onDevice.map(n => [n.notifId, n]));
  const schedule = [];
  const cancel = [];
  const keep = [];
  for (const entry of desired) {
    const existing = deviceById.get(entry.notifId);
    if (!existing) {
      schedule.push(entry);
    } else if (existing.fireAtMs !== entry.fireAtMs || existing.serverId !== entry.serverId) {
      cancel.push(entry.notifId);
      schedule.push(entry);
    } else {
      keep.push(entry.serverId);
    }
  }
  for (const notif of onDevice) {
    if (!desiredById.has(notif.notifId)) cancel.push(notif.notifId);
  }
  return { schedule, cancel, keep };
}

/**
 * The honest-wording contract. scheduled=true is the ONLY case that may
 * say "set": the notification is on this device. Otherwise the reminder
 * is saved server-side and rings where the app is installed + signed in.
 */
export function confirmationText({ scheduled, entry }) {
  const when = new Date(entry.fireAtMs).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  return scheduled
    ? `Reminder set for ${when}: "${entry.title}".`
    : `Reminder saved for ${when}: "${entry.title}" — it'll ring on the phone where the ThinkinBuddy app is installed and signed in.`;
}

// ─── Local record (what THIS device has scheduled) ─────────────────────

function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

function readRecord(storage) {
  try {
    const raw = storage?.getItem(RECORD_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      return { userId: parsed.userId || null, entries: parsed.entries };
    }
  } catch { /* corrupted record -> start fresh */ }
  return { userId: null, entries: {} };
}

function writeRecord(storage, record) {
  try { storage?.setItem(RECORD_KEY, JSON.stringify(record)); } catch { /* storage unavailable */ }
}

// ─── Permission ──────────────────────────────────────────────────────────

async function ensurePermission(plugin) {
  try {
    let status = await plugin.checkPermissions();
    if (status?.display === 'granted') return true;
    if (status?.display === 'denied') return false;
    status = await plugin.requestPermissions();
    return status?.display === 'granted';
  } catch {
    return false;
  }
}

// ─── Sync engine ─────────────────────────────────────────────────────────
// deps are injectable for tests: { plugin, fetchFn, storage, userId,
// nowMs }. Defaults resolve from the live page (Capacitor bridge,
// localStorage tb_tenant / thinkinbuddy_user_id, global fetch).

function runtimeUserId() {
  const storage = defaultStorage();
  return resolveAlarmUserId({
    tenantId: storage?.getItem('tb_tenant'),
    legacyUserId: storage?.getItem('thinkinbuddy_user_id'),
  });
}

export async function syncAlarms(deps = {}) {
  const plugin = deps.plugin !== undefined ? deps.plugin : localNotificationsPlugin();
  if (!plugin) return { available: false }; // plain web: no claims, no fetches

  const fetchFn = deps.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchFn) return { available: false };
  const storage = deps.storage !== undefined ? deps.storage : defaultStorage();
  const userId = deps.userId || runtimeUserId();
  const nowMs = deps.nowMs ?? Date.now();
  const base = deps.baseUrl || '';

  const result = {
    available: true, permission: false,
    scheduled: [], cancelled: [], expired: [], deletionCheck: false,
  };

  // Fetch pending + (when the server supports it) the all-list.
  let pendingRaw = [];
  let allRaw = null;
  try {
    const res = await fetchFn(`${base}/api/alarm/pending?userId=${encodeURIComponent(userId)}`);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) return { ...result, error: 'pending_fetch_failed' };
    pendingRaw = Array.isArray(data.alarms) ? data.alarms : [];
  } catch {
    return { ...result, error: 'pending_fetch_failed' };
  }
  try {
    const res = await fetchFn(`${base}/api/alarm/pending?userId=${encodeURIComponent(userId)}&all=1`);
    const data = await res.json().catch(() => null);
    if (res.ok && data?.ok && Array.isArray(data.alarms)) {
      allRaw = data.alarms;
      result.deletionCheck = true;
    }
  } catch { /* older server: deletion detection skipped this sync */ }

  const markDelivered = async (serverId) => {
    try {
      await fetchFn(`${base}/api/alarm?id=${encodeURIComponent(serverId)}&userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
    } catch { /* stays pending; a later sync retries */ }
  };

  // Local record, scoped to its owner. A different user on this device:
  // cancel the previous user's on-device alarms before proceeding.
  const record = readRecord(storage);
  if (record.userId && record.userId !== userId) {
    const staleIds = Object.values(record.entries).map(e => e.notifId).filter(Number.isFinite);
    if (staleIds.length) {
      try { await plugin.cancel({ notifications: staleIds.map(id => ({ id })) }); } catch { /* best effort */ }
      result.cancelled.push(...staleIds);
    }
    record.entries = {};
  }
  record.userId = userId;

  const serverKnown = allRaw ? new Set(allRaw.map(e => String(e?.id))) : null;
  const allById = new Map((allRaw || []).map(e => [String(e?.id), e]));

  // ── Build the desired set ──
  const desired = new Map(); // serverId -> entry
  const handled = new Set(); // serverIds accounted for by the pending list

  for (const raw of pendingRaw) {
    const entry = toScheduleEntry(raw);
    if (!entry) continue;
    handled.add(entry.serverId);
    if (entry.fireAtMs <= nowMs) {
      result.expired.push(entry.serverId); // never schedule the past
      await markDelivered(entry.serverId);
      delete record.entries[entry.serverId];
      continue;
    }
    desired.set(entry.serverId, entry);
  }

  for (const [serverId, rec] of Object.entries(record.entries)) {
    if (handled.has(serverId) || desired.has(serverId)) continue;
    if (serverKnown && !serverKnown.has(serverId)) continue; // deleted server-side -> planSync cancels it
    const raw = allById.get(serverId);
    if (raw && raw.pending === false) {
      // Ours, already delivered (by us): keep it desired while future.
      const entry = toScheduleEntry(raw);
      if (entry && entry.fireAtMs > nowMs) desired.set(serverId, entry);
      else delete record.entries[serverId];
    }
    // Not in the all-list and deletionCheck off: keep the local entry
    // desired from the record itself (server state unknown, don't drop).
    if (!serverKnown && rec.fireAtMs > nowMs) {
      desired.set(serverId, {
        serverId, notifId: rec.notifId, fireAtMs: rec.fireAtMs,
        title: rec.title || 'Reminder', body: rec.body || '',
      });
    } else if (!serverKnown) {
      delete record.entries[serverId];
    }
  }

  // ── Permission gate: nothing is scheduled — or marked delivered —
  // without it. Entries stay pending server-side for a later sync. ──
  result.permission = await ensurePermission(plugin);
  if (!result.permission) {
    return { ...result, reason: 'notification_permission_not_granted' };
  }

  // ── Diff against what is actually on the device ──
  let onDevice = [];
  try {
    const pending = await plugin.getPending();
    onDevice = (pending?.notifications || [])
      .filter(n => n && n.extra && n.extra.tbAlarm === 1 && n.extra.serverId)
      .map(n => ({
        notifId: n.id,
        serverId: String(n.extra.serverId),
        fireAtMs: n.schedule?.at ? new Date(n.schedule.at).getTime() : NaN,
      }));
  } catch { /* treat as empty: planSync will (re)schedule the desired set */ }

  const plan = planSync([...desired.values()], onDevice);

  if (plan.cancel.length) {
    try {
      await plugin.cancel({ notifications: plan.cancel.map(id => ({ id })) });
      result.cancelled.push(...plan.cancel);
    } catch { /* entries stay pending; next sync retries */ }
    const cancelledSet = new Set(plan.cancel);
    for (const [serverId, rec] of Object.entries(record.entries)) {
      if (cancelledSet.has(rec.notifId) && !desired.has(serverId)) delete record.entries[serverId];
    }
  }

  if (plan.schedule.length) {
    try {
      await plugin.schedule({
        notifications: plan.schedule.map(e => ({
          id: e.notifId,
          title: e.title,
          body: e.body || e.title,
          schedule: { at: new Date(e.fireAtMs), allowWhileIdle: true },
          extra: { tbAlarm: 1, serverId: e.serverId, fireAtMs: e.fireAtMs },
        })),
      });
      for (const e of plan.schedule) {
        result.scheduled.push(e.serverId);
        record.entries[e.serverId] = {
          notifId: e.notifId, fireAtMs: e.fireAtMs, title: e.title, body: e.body,
        };
      }
    } catch {
      return { ...result, error: 'schedule_failed' };
    }
  }

  // Record every desired entry (kept ones included), then mark delivered
  // every desired entry the server still lists as pending — that is the
  // handshake's "this client picked it up" signal.
  for (const e of desired.values()) {
    record.entries[e.serverId] = {
      notifId: e.notifId, fireAtMs: e.fireAtMs, title: e.title, body: e.body,
    };
  }
  writeRecord(storage, record);
  const pendingIds = new Set(pendingRaw.map(r => String(r?.id)));
  for (const e of desired.values()) {
    if (pendingIds.has(e.serverId)) await markDelivered(e.serverId);
  }

  return result;
}

/**
 * Cancel one alarm on this device (in-app deletion path): cancel the
 * notification, drop the local record, and mark the server save
 * delivered so it is never handed out as pending again. (The server has
 * no true delete; mark-delivered is its only "stop returning this"
 * signal.)
 */
export async function cancelAlarm(serverId, deps = {}) {
  const plugin = deps.plugin !== undefined ? deps.plugin : localNotificationsPlugin();
  if (!plugin) return { available: false };
  const storage = deps.storage !== undefined ? deps.storage : defaultStorage();
  const userId = deps.userId || runtimeUserId();
  const fetchFn = deps.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  const base = deps.baseUrl || '';
  const id = String(serverId);
  const notifId = notificationIdFor(id);
  try { await plugin.cancel({ notifications: [{ id: notifId }] }); } catch { /* best effort */ }
  const record = readRecord(storage);
  if (record.entries[id]) {
    delete record.entries[id];
    writeRecord(storage, record);
  }
  if (fetchFn) {
    try {
      await fetchFn(`${base}/api/alarm?id=${encodeURIComponent(id)}&userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
    } catch { /* best effort */ }
  }
  return { available: true, ok: true };
}

/**
 * Schedule one Actionable phone_action right now (capture-time path).
 * Returns { available, scheduled, entry?, confirmation } — the
 * confirmation follows the honest-wording contract either way.
 */
export async function schedulePhoneAction(action, deps = {}) {
  const entry = phoneActionToEntry(action, deps.nowMs ?? Date.now());
  if (!entry) return { available: true, scheduled: false, reason: 'no_actionable_time' };
  const plugin = deps.plugin !== undefined ? deps.plugin : localNotificationsPlugin();
  if (!plugin) {
    return { available: false, scheduled: false, entry, confirmation: confirmationText({ scheduled: false, entry }) };
  }
  const granted = await ensurePermission(plugin);
  if (!granted) {
    return { available: true, scheduled: false, entry, reason: 'notification_permission_not_granted', confirmation: confirmationText({ scheduled: false, entry }) };
  }
  try {
    await plugin.schedule({
      notifications: [{
        id: entry.notifId,
        title: entry.title,
        body: entry.body || entry.title,
        schedule: { at: new Date(entry.fireAtMs), allowWhileIdle: true },
        extra: { tbAlarm: 1, serverId: entry.serverId, fireAtMs: entry.fireAtMs },
      }],
    });
  } catch (e) {
    return { available: true, scheduled: false, entry, error: e?.message || String(e), confirmation: confirmationText({ scheduled: false, entry }) };
  }
  return { available: true, scheduled: true, entry, confirmation: confirmationText({ scheduled: true, entry }) };
}

// ─── Start / stop (app start, after login, foreground) ──────────────────

let started = false;
let timer = null;
let visibilityHook = null;
let focusHook = null;

/**
 * Start the background sync: one sync immediately, then a poll every
 * `intervalMs` while the app lives, plus a re-sync whenever the app
 * returns to the foreground (visibilitychange -> visible, window
 * focus). Idempotent: later calls just trigger an immediate re-sync
 * (that is the after-login path). No-ops cleanly on plain web.
 */
export async function startAlarmSync(opts = {}) {
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_MS;
  if (started) {
    await syncAlarms(opts.deps || {});
    return { available: true, alreadyStarted: true };
  }
  started = true;
  const first = await syncAlarms(opts.deps || {});
  if (!first.available) { started = false; return first; }
  if (intervalMs > 0 && typeof setInterval !== 'undefined') {
    timer = setInterval(() => { syncAlarms(opts.deps || {}).catch(() => {}); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    visibilityHook = () => {
      if (document.visibilityState === 'visible') syncAlarms(opts.deps || {}).catch(() => {});
    };
    document.addEventListener('visibilitychange', visibilityHook);
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    focusHook = () => { syncAlarms(opts.deps || {}).catch(() => {}); };
    window.addEventListener('focus', focusHook);
  }
  return first;
}

export function stopAlarmSync() {
  if (timer) { clearInterval(timer); timer = null; }
  if (visibilityHook && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHook);
    visibilityHook = null;
  }
  if (focusHook && typeof window !== 'undefined') {
    window.removeEventListener('focus', focusHook);
    focusHook = null;
  }
  started = false;
}
