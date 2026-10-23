// public/connect.js — the Helmian Connect panel inside Settings ->
// Account & Safety (the #accountPane onboarding.js wires). Plain ES
// module, no build step; index.html loads it as
// <script type="module" src="/connect.js"></script> right after
// /onboarding.js, and this module injects its DOM into the pane from
// JS — index.html carries no Connect markup of its own.
//
// ─── Server contract (relay bite) ────────────────────────────────────
// GET  /api/profile            -> { plan, entitlement_status, ... }
// POST /api/relay/pair/create  -> 200 { code, expiresAt }
//                              | 403 { error: 'helmian_connect_required' }
// GET  /api/relay/devices      -> 200 { devices: [{ id, device_label,
//                                   paired_at, last_seen_at, revoked_at }] }
// POST /api/relay/pair/revoke  { deviceId } -> 200 { ok: true }
// Every call rides the session via tbFetch from ./onboarding.js
// (Authorization: Bearer <tb_token>). In legacy mode (no accounts) the
// profile probe answers 503 and the Account pane hides itself — this
// module then renders nothing at all. Signed-out (401) also renders
// nothing: onboarding owns the sign-in flow.
//
// The pairing code is shown ONCE here, big, with its expiry counting
// down — the parent types it into Helmian on the computer being
// paired. The device token never reaches this module: redeem happens
// computer-side, and the device list carries labels + timestamps only.

import { tbFetch } from './onboarding.js';

const UPSELL_LINE = 'Helmian Connect — give your buddy hands on your computer. Available on the Helmian Connect plan.';
const CODE_STYLE = 'font-size:2.2rem;letter-spacing:0.35em;text-align:center;color:#e0f0ff;font-family:\'Courier New\',monospace;margin:10px 0;';

async function api(path, opts = {}) {
  const res = await tbFetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function panel() {
  const pane = document.getElementById('accountPane');
  if (!pane) return null;
  let el = document.getElementById('connectPanel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'connectPanel';
    pane.appendChild(el);
  }
  return el;
}

let countdownTimer = null;
function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}

function fmtTime(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
}

// ─── Device list ───────────────────────────────────────────────────────

async function loadDevices() {
  const host = document.getElementById('connectDevices');
  if (!host) return;
  const res = await api('/api/relay/devices').catch(() => null);
  host.textContent = '';
  const devices = res?.status === 200 && Array.isArray(res.data?.devices)
    ? res.data.devices
    : null;
  if (!devices || devices.length === 0) {
    const line = document.createElement('div');
    line.className = 'test-line';
    line.textContent = 'No computers connected yet.';
    host.appendChild(line);
    return;
  }
  for (const device of devices) {
    const row = document.createElement('div');
    row.className = 'test-line';

    const name = document.createElement('strong');
    name.textContent = device.device_label || 'Computer';
    row.appendChild(name);

    const seen = fmtTime(device.last_seen_at);
    const detail = document.createElement('span');
    detail.textContent = device.revoked_at
      ? ' — revoked'
      : ` — last seen ${seen || 'not yet'}`;
    row.appendChild(detail);

    if (!device.revoked_at) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary';
      btn.textContent = 'Revoke';
      btn.style.marginLeft = '10px';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const out = await api('/api/relay/pair/revoke', {
          method: 'POST',
          body: { deviceId: device.id },
        }).catch(() => null);
        if (out?.status === 200) loadDevices();
        else btn.disabled = false;
      });
      row.appendChild(btn);
    }
    host.appendChild(row);
  }
}

// ─── Renders ───────────────────────────────────────────────────────────

function renderUpsell(el) {
  stopCountdown();
  el.textContent = '';
  const line = document.createElement('div');
  line.className = 'test-line';
  line.textContent = UPSELL_LINE;
  el.appendChild(line);
}

function renderConnect(el) {
  stopCountdown();
  el.innerHTML = `
    <label>Helmian Connect</label>
    <div class="test-line">Helmian Connect is on your plan. Pair a computer and your buddy can work on it — with Guard approving every action.</div>
    <button type="button" class="secondary" id="connectPairBtn">Connect a computer</button>
    <div id="connectCodeBlock" style="display:none;">
      <div id="connectCode" style="${CODE_STYLE}"></div>
      <div class="test-line" id="connectCodeLine"></div>
    </div>
    <div class="test-line" id="connectStatusLine"></div>
    <label>Connected computers</label>
    <div id="connectDevices"></div>
  `;
  document.getElementById('connectPairBtn')
    ?.addEventListener('click', createCode);
  loadDevices();
}

async function createCode() {
  const status = document.getElementById('connectStatusLine');
  const block = document.getElementById('connectCodeBlock');
  const codeEl = document.getElementById('connectCode');
  const lineEl = document.getElementById('connectCodeLine');
  if (status) status.textContent = '';
  const res = await api('/api/relay/pair/create', { method: 'POST', body: {} })
    .catch(() => null);
  if (!res) {
    if (status) status.textContent = 'Could not reach the server — try again.';
    return;
  }
  if (res.status === 403) {
    if (status) status.textContent = 'Helmian Connect is not active on this account.';
    return;
  }
  if (res.status !== 200 || !res.data?.code) {
    if (status) status.textContent = 'Could not create a pairing code — try again.';
    return;
  }
  if (block) block.style.display = '';
  if (codeEl) codeEl.textContent = res.data.code;
  const expiresAt = new Date(res.data.expiresAt).getTime();
  stopCountdown();
  const paint = () => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    if (!lineEl) return;
    if (left <= 0) {
      stopCountdown();
      lineEl.textContent = 'That code expired — create a new one.';
      if (codeEl) codeEl.textContent = '······';
      return;
    }
    const m = Math.floor(left / 60);
    const s = String(left % 60).padStart(2, '0');
    lineEl.textContent = `Type this code into Helmian on the computer — expires in ${m}:${s}.`;
  };
  paint();
  countdownTimer = setInterval(paint, 1000);
}

// ─── Boot ──────────────────────────────────────────────────────────────

async function init() {
  const pane = document.getElementById('accountPane');
  if (!pane) return;
  let prof;
  try {
    prof = await api('/api/profile');
  } catch {
    return; // server unreachable — render nothing, never wedge Settings
  }
  if (prof.status !== 200 || !prof.data) return; // legacy (503) or signed out (401)
  const el = panel();
  if (!el) return;
  if (prof.data.plan === 'helmian_connect') renderConnect(el);
  else renderUpsell(el);
}

init();

// Refresh (plan + devices) whenever the parent opens the Account tab.
document.querySelector('.tabs button[data-tab="account"]')
  ?.addEventListener('click', () => { init(); });
