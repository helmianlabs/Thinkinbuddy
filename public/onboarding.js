// public/onboarding.js — ThinkinBuddy accounts front end (sign-in,
// first-run onboarding, Account & Safety settings).
//
// PLAIN ES module, no build step. Loaded by index.html as
// <script type="module" src="/onboarding.js"></script> (public/ files are
// served at the site root — same pattern as /manifest.json and /icon.svg).
// All DOM it drives lives in index.html: the #accountOverlay container
// (this module fills it) and the Settings -> "Account & Safety" pane.
//
// ─── Two modes, and the app must never break in either ─────────────────
// LEGACY (single-user, self-hosted): the server has no SESSION_SECRET, so
// /api/profile answers 503 { error: 'accounts_not_configured' }. The
// overlay NEVER appears, the Account & Safety tab hides itself, and the
// app behaves exactly as it always has (localStorage user, own keys).
// ACCOUNTS (hosted): /api/profile without a valid token answers 401.
// With no stored token the auth overlay shows; after sign-in, a profile
// with no display_name yet gets the onboarding steps. Any network error
// during the probe also degrades to legacy behaviour — sign-in UI must
// never wedge the buddy itself.
//
// ─── Server contract (bite 5a, server/handlers/auth.js + profile.js) ──
// POST /api/auth/signup  -> 201 { token, tenantId } | 409 email_taken |
//                           400 invalid_email / weak_password
// POST /api/auth/login   -> 200 { token, tenantId } | 401 invalid_credentials
// GET  /api/profile      -> { tenantId, display_name, age_band, about_me,
//                             safety_mode, pin_set, plan, entitlement_status }
// PUT  /api/profile      -> whitelisted fields; safety_mode:false with a
//                           PIN set needs { pin } too, else
//                           403 parent_pin_required / invalid_parent_pin
// POST /api/profile/pin        { pin } -> set/replace the parent PIN
// POST /api/profile/pin/verify { pin } -> { ok: boolean }
// POST /api/auth/delete-account { password } -> 200 { deleted: true } |
//                           401 invalid_credentials (session + current
//                           password both required; erases the tenant)
// Every accounts endpoint answers 503 accounts_not_configured in legacy
// mode. Auth header: Authorization: Bearer <token>.
//
// Age band VALUES are lib/profile.js AGE_BANDS, exactly:
// ['child', '6-8', '9-12', '13-17', 'adult'] — labels are friendlier.

const TOKEN_KEY = 'tb_token';
const TENANT_KEY = 'tb_tenant';

const AGE_BAND_OPTIONS = [
  { value: 'child', label: 'Under 6' },
  { value: '6-8', label: '6–8' },
  { value: '9-12', label: '9–12' },
  { value: '13-17', label: '13–17' },
  { value: 'adult', label: 'Adult' },
];
// Bands where safety mode defaults ON in onboarding (mirrors the
// kid-core semantics server-side: child / 6-8 / 9-12 are minors).
const MINOR_BANDS = ['child', '6-8', '9-12'];
const PIN_COPY = 'This PIN keeps safety settings locked. Only a parent should know it.';

// Small shared inline styles for elements the .onboarding CSS in
// index.html does not cover (select/textarea/error lines).
const FIELD_STYLE = 'background:rgba(0,212,255,0.05);border:1px solid rgba(0,212,255,0.3);color:#e0f0ff;padding:14px 18px;font-family:\'Courier New\',monospace;font-size:1rem;width:280px;max-width:90vw;border-radius:4px;outline:none;text-align:center;letter-spacing:0.05em;';
const ERR_STYLE = 'color:#ff8a8a;font-size:0.8rem;min-height:1.2em;margin:12px 0 0;max-width:380px;line-height:1.5;';
const LINK_BTN_STYLE = 'background:transparent;border:none;color:#7dd3fc;text-decoration:underline;letter-spacing:0.05em;text-transform:none;font-size:0.8rem;margin-top:14px;cursor:pointer;';

// ─── Session storage + fetch ────────────────────────────────────────────

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function getTenantId() {
  try { return localStorage.getItem(TENANT_KEY); } catch { return null; }
}

function storeSession(token, tenantId) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    if (tenantId) localStorage.setItem(TENANT_KEY, tenantId);
  } catch { /* storage unavailable — session just won't persist */ }
}

function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TENANT_KEY);
  } catch { /* ignore */ }
}

/**
 * fetch() for this app's /api routes with the session token attached.
 * Same signature as fetch(); a plain-object body is JSON-encoded.
 * Exported so other front-end modules can ride the same session.
 */
export async function tbFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let body = opts.body;
  if (body && typeof body === 'object') {
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  return fetch(path, { ...opts, headers, body });
}

/** tbFetch + JSON body parsing; never throws on a non-JSON response. */
async function api(path, opts = {}) {
  const res = await tbFetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function isAccountsOff(result) {
  return result.status === 503 && result.data?.error === 'accounts_not_configured';
}

// ─── Billing hook (never allowed to break sign-in) ─────────────────────

async function wireBilling(tenantId) {
  if (!tenantId) return;
  try {
    if (!window.Capacitor?.Plugins?.Purchases) return; // plain web: no plugin
    const { configureBilling } = await import('./billing.js');
    await configureBilling(tenantId);
  } catch { /* billing is optional at sign-in time; swallow everything */ }
}

// ─── Overlay (auth + onboarding steps) ──────────────────────────────────

const overlayEl = () => document.getElementById('accountOverlay');

function showOverlay(html) {
  const el = overlayEl();
  if (!el) return;
  el.innerHTML = html;
  el.classList.remove('hidden');
}

function hideOverlay() {
  const el = overlayEl();
  if (!el) return;
  el.classList.add('hidden');
  el.innerHTML = '';
}

function authErrorText(data) {
  switch (data?.error) {
    case 'invalid_credentials': return "Email or password didn't match.";
    case 'email_taken': return 'That email already has an account — log in instead.';
    case 'invalid_email': return "That email doesn't look right.";
    case 'weak_password': return 'Password needs at least 10 characters.';
    default: return 'Something went wrong — please try again.';
  }
}

function showAuth() {
  let mode = 'login'; // | 'signup'
  showOverlay(`
    <h1>THINKINBUDDY</h1>
    <p id="acctAuthIntro">Welcome back. Log in to your buddy account.</p>
    <input type="email" id="acctEmail" placeholder="Email" autocomplete="email" />
    <input type="password" id="acctPassword" placeholder="Password" autocomplete="current-password" style="margin-top:12px;" />
    <p id="acctAuthError" style="${ERR_STYLE}"></p>
    <button id="acctAuthSubmit">Log in</button>
    <button type="button" id="acctAuthToggle" style="${LINK_BTN_STYLE}">New here? Create an account</button>
  `);
  const emailEl = document.getElementById('acctEmail');
  const passwordEl = document.getElementById('acctPassword');
  const errorEl = document.getElementById('acctAuthError');
  const submitEl = document.getElementById('acctAuthSubmit');
  const toggleEl = document.getElementById('acctAuthToggle');
  const introEl = document.getElementById('acctAuthIntro');

  const paint = () => {
    submitEl.textContent = mode === 'signup' ? 'Create account' : 'Log in';
    toggleEl.textContent = mode === 'signup' ? 'Already have an account? Log in' : 'New here? Create an account';
    introEl.textContent = mode === 'signup'
      ? 'Create your account — then we set up your buddy together.'
      : 'Welcome back. Log in to your buddy account.';
    passwordEl.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    errorEl.textContent = '';
  };
  toggleEl.addEventListener('click', () => {
    mode = mode === 'signup' ? 'login' : 'signup';
    paint();
  });

  submitEl.addEventListener('click', async () => {
    const email = emailEl.value.trim();
    const password = passwordEl.value;
    if (!email || !password) {
      errorEl.textContent = 'Enter your email and password.';
      return;
    }
    submitEl.disabled = true;
    errorEl.textContent = '';
    try {
      const path = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
      const result = await api(path, { method: 'POST', body: { email, password } });
      if (isAccountsOff(result)) { enterLegacyMode(); return; }
      if ((result.status === 200 || result.status === 201) && result.data?.token) {
        storeSession(result.data.token, result.data.tenantId);
        await wireBilling(result.data.tenantId);
        let prof = null;
        try { prof = await api('/api/profile'); } catch { prof = null; }
        if (prof && isAccountsOff(prof)) { enterLegacyMode(); return; }
        profileCache = prof?.data || null;
        refreshAccountPane();
        if (!prof?.data?.display_name) showOnboarding();
        else hideOverlay();
        return;
      }
      errorEl.textContent = authErrorText(result.data);
    } catch {
      errorEl.textContent = 'Could not reach the server — please try again.';
    } finally {
      submitEl.disabled = false;
    }
  });
}

function showOnboarding() {
  const bandOptions = AGE_BAND_OPTIONS
    .map(o => `<option value="${o.value}"${o.value === 'adult' ? ' selected' : ''}>${o.label}</option>`)
    .join('');
  showOverlay(`
    <h1>THINKINBUDDY</h1>
    <p>Let's set up your buddy — four quick steps.</p>
    <div class="acct-step" data-step="1">
      <p>What should your buddy call you?</p>
      <input type="text" id="acctName" placeholder="Your name" autocomplete="name" />
      <p class="acct-err" style="${ERR_STYLE}"></p>
      <button data-next="1">Continue</button>
    </div>
    <div class="acct-step" data-step="2" style="display:none;">
      <p>Who is this buddy for?</p>
      <select id="acctBand" style="${FIELD_STYLE}">${bandOptions}</select>
      <p class="acct-err" style="${ERR_STYLE}"></p>
      <button data-next="2">Continue</button>
    </div>
    <div class="acct-step" data-step="3" style="display:none;">
      <p>What should your buddy know about you?</p>
      <textarea id="acctAbout" rows="4" placeholder="Interests, goals, how you like to learn…" style="${FIELD_STYLE}text-align:left;"></textarea>
      <p class="acct-err" style="${ERR_STYLE}"></p>
      <button data-next="3">Continue</button>
      <button type="button" id="acctAboutSkip" style="${LINK_BTN_STYLE}">Skip this step</button>
    </div>
    <div class="acct-step" data-step="4" style="display:none;">
      <p>Safety mode adds extra guardrails for younger users.</p>
      <label style="display:flex;align-items:center;gap:10px;justify-content:center;color:#e0f0ff;font-size:0.95rem;">
        <input type="checkbox" id="acctSafety" style="width:auto;padding:0;" /> Safety mode
      </label>
      <div id="acctPinBlock" style="display:none;margin-top:16px;">
        <p style="margin-bottom:12px;">${PIN_COPY}</p>
        <input type="password" id="acctPin" inputmode="numeric" autocomplete="off" placeholder="Parent PIN (4–6 digits)" />
        <input type="password" id="acctPinAgain" inputmode="numeric" autocomplete="off" placeholder="Parent PIN again" style="margin-top:12px;" />
      </div>
      <p class="acct-err" style="${ERR_STYLE}"></p>
      <button id="acctSave">Save &amp; start</button>
    </div>
  `);

  const steps = [...document.querySelectorAll('#accountOverlay .acct-step')];
  const gotoStep = (n) => {
    steps.forEach(s => { s.style.display = s.dataset.step === String(n) ? '' : 'none'; });
    if (n === 4) syncSafetyDefault();
  };
  const errOf = (n) => steps[n - 1].querySelector('.acct-err');

  const nameEl = document.getElementById('acctName');
  const bandEl = document.getElementById('acctBand');
  const safetyEl = document.getElementById('acctSafety');
  const pinBlock = document.getElementById('acctPinBlock');
  let safetyTouched = false;

  const syncSafetyDefault = () => {
    if (!safetyTouched) safetyEl.checked = MINOR_BANDS.includes(bandEl.value);
    pinBlock.style.display = safetyEl.checked ? '' : 'none';
  };
  safetyEl.addEventListener('change', () => {
    safetyTouched = true;
    pinBlock.style.display = safetyEl.checked ? '' : 'none';
  });

  steps[0].querySelector('[data-next="1"]').addEventListener('click', () => {
    if (!nameEl.value.trim()) { errOf(1).textContent = 'Your buddy needs a name to call you.'; return; }
    gotoStep(2);
  });
  steps[1].querySelector('[data-next="2"]').addEventListener('click', () => gotoStep(3));
  steps[2].querySelector('[data-next="3"]').addEventListener('click', () => gotoStep(4));
  document.getElementById('acctAboutSkip').addEventListener('click', () => {
    document.getElementById('acctAbout').value = '';
    gotoStep(4);
  });

  document.getElementById('acctSave').addEventListener('click', async (ev) => {
    const err = errOf(4);
    err.textContent = '';
    const pin = document.getElementById('acctPin').value.trim();
    const pinAgain = document.getElementById('acctPinAgain').value.trim();
    if (safetyEl.checked && (pin || pinAgain)) {
      if (!/^\d{4,6}$/.test(pin)) { err.textContent = 'The parent PIN must be 4–6 digits.'; return; }
      if (pin !== pinAgain) { err.textContent = "The two PINs didn't match."; return; }
    }
    ev.target.disabled = true;
    try {
      const saved = await api('/api/profile', {
        method: 'PUT',
        body: {
          display_name: nameEl.value.trim(),
          age_band: bandEl.value,
          about_me: document.getElementById('acctAbout').value.trim() || null,
          safety_mode: safetyEl.checked,
        },
      });
      if (isAccountsOff(saved)) { enterLegacyMode(); return; }
      if (saved.status !== 200) { err.textContent = 'Could not save — please try again.'; return; }
      profileCache = saved.data;
      if (safetyEl.checked && pin) {
        const pinRes = await api('/api/profile/pin', { method: 'POST', body: { pin } });
        if (pinRes.status !== 200) {
          err.textContent = 'Profile saved, but the PIN did not stick — set it again in Settings → Account & Safety.';
          refreshAccountPane();
          return;
        }
        if (profileCache) profileCache.pin_set = true;
      }
      refreshAccountPane();
      hideOverlay();
    } catch {
      err.textContent = 'Could not reach the server — please try again.';
    } finally {
      ev.target.disabled = false;
    }
  });
}

// ─── Settings -> Account & Safety pane ──────────────────────────────────

let profileCache = null;
let accountsMode = false; // true once the server proves it has accounts

function hideAccountPane() {
  const pane = document.getElementById('accountPane');
  if (pane) pane.style.display = 'none';
  const tab = document.querySelector('.tabs button[data-tab="account"]');
  if (tab) tab.style.display = 'none';
}

function enterLegacyMode() {
  accountsMode = false;
  hideOverlay();
  hideAccountPane();
}

async function refreshAccountPane(force = false) {
  if (!accountsMode) return;
  const planLine = document.getElementById('accountPlanLine');
  const safetyToggle = document.getElementById('accountSafetyToggle');
  const pinStatus = document.getElementById('accountPinStatus');
  const currentPinRow = document.getElementById('accountCurrentPinRow');
  if (!planLine) return;

  if (force) profileCache = null;
  if (!profileCache) {
    const prof = await api('/api/profile').catch(() => null);
    if (!prof || isAccountsOff(prof)) { if (prof) enterLegacyMode(); return; }
    if (prof.status === 200) profileCache = prof.data;
  }
  if (!profileCache) {
    planLine.textContent = 'Plan: sign in to see your plan.';
    if (safetyToggle) safetyToggle.disabled = true;
    return;
  }
  const plan = profileCache.plan || 'free';
  planLine.textContent = profileCache.entitlement_status && profileCache.entitlement_status !== 'active'
    ? `Plan: ${plan} (${profileCache.entitlement_status})`
    : `Plan: ${plan}`;
  if (safetyToggle) {
    safetyToggle.disabled = false;
    safetyToggle.checked = profileCache.safety_mode === true;
  }
  if (pinStatus) pinStatus.textContent = profileCache.pin_set ? 'A parent PIN is set.' : 'No parent PIN set.';
  if (currentPinRow) currentPinRow.style.display = profileCache.pin_set ? '' : 'none';
}

function setLine(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text || '';
}

function wireAccountPane() {
  const safetyToggle = document.getElementById('accountSafetyToggle');
  const pinRow = document.getElementById('accountSafetyPinRow');
  const pinInput = document.getElementById('accountSafetyPin');
  const pinConfirm = document.getElementById('accountSafetyPinConfirm');
  if (!safetyToggle) return;

  safetyToggle.addEventListener('change', async () => {
    setLine('accountStatusLine', '');
    if (safetyToggle.checked) {
      // Turning safety ON never needs a PIN.
      const res = await api('/api/profile', { method: 'PUT', body: { safety_mode: true } }).catch(() => null);
      if (res && res.status === 200) {
        profileCache = res.data;
        setLine('accountStatusLine', 'Safety mode is on.');
      } else {
        safetyToggle.checked = false;
        setLine('accountStatusLine', 'Could not turn safety mode on — try again.');
      }
      return;
    }
    // Turning OFF: with a PIN set, the parent proves it inline first.
    if (profileCache?.pin_set) {
      safetyToggle.checked = true; // stays on until the PIN checks out
      if (pinRow) pinRow.style.display = '';
      pinInput?.focus();
      setLine('accountStatusLine', 'Enter the parent PIN to turn safety mode off.');
      return;
    }
    await turnSafetyOff(null);
  });

  pinConfirm?.addEventListener('click', async () => {
    await turnSafetyOff(pinInput?.value.trim() || '');
    if (pinInput) pinInput.value = '';
  });

  async function turnSafetyOff(pin) {
    const body = { safety_mode: false };
    if (pin) body.pin = pin;
    const res = await api('/api/profile', { method: 'PUT', body }).catch(() => null);
    if (res && isAccountsOff(res)) { enterLegacyMode(); return; }
    if (res && res.status === 200) {
      profileCache = res.data;
      safetyToggle.checked = false;
      if (pinRow) pinRow.style.display = 'none';
      setLine('accountStatusLine', res.data.warning === 'no_parent_pin_set'
        ? 'Safety mode is off. Note: no parent PIN is set, so anyone with this phone can change safety settings.'
        : 'Safety mode is off.');
      refreshAccountPane();
      return;
    }
    if (res && res.status === 403) {
      safetyToggle.checked = true;
      setLine('accountStatusLine', res.data?.error === 'parent_pin_required'
        ? 'A parent PIN is required to turn safety mode off.'
        : "That PIN didn't match — safety mode is still on.");
      return;
    }
    safetyToggle.checked = true;
    setLine('accountStatusLine', 'Could not turn safety mode off — try again.');
  }

  document.getElementById('accountPinSave')?.addEventListener('click', async () => {
    setLine('accountPinLine', '');
    const newPin = document.getElementById('accountNewPin')?.value.trim() || '';
    const newPinAgain = document.getElementById('accountNewPinConfirm')?.value.trim() || '';
    if (!/^\d{4,6}$/.test(newPin)) { setLine('accountPinLine', 'The PIN must be 4–6 digits.'); return; }
    if (newPin !== newPinAgain) { setLine('accountPinLine', "The two PINs didn't match."); return; }
    try {
      if (profileCache?.pin_set) {
        const current = document.getElementById('accountCurrentPin')?.value.trim() || '';
        const verify = await api('/api/profile/pin/verify', { method: 'POST', body: { pin: current } });
        if (isAccountsOff(verify)) { enterLegacyMode(); return; }
        if (!verify.data?.ok) { setLine('accountPinLine', "Current PIN didn't match — PIN unchanged."); return; }
      }
      const res = await api('/api/profile/pin', { method: 'POST', body: { pin: newPin } });
      if (isAccountsOff(res)) { enterLegacyMode(); return; }
      if (res.status !== 200) { setLine('accountPinLine', 'Could not save the PIN — try again.'); return; }
      if (profileCache) profileCache.pin_set = true;
      for (const id of ['accountCurrentPin', 'accountNewPin', 'accountNewPinConfirm']) {
        const el = document.getElementById(id);
        if (el) el.value = '';
      }
      setLine('accountPinLine', 'Parent PIN saved.');
      refreshAccountPane();
    } catch {
      setLine('accountPinLine', 'Could not reach the server — try again.');
    }
  });

  document.getElementById('accountLogout')?.addEventListener('click', () => {
    clearSession();
    location.reload();
  });

  // ─── Delete my account (Apple 5.1.1(v) / Play deletion rule) ──────
  // Two deliberate speed bumps before the call: the confirm row stays
  // hidden until "Delete my account" is tapped, and the final button
  // does nothing until the parent types DELETE *and* enters the
  // account password (the server checks the password too — this is a
  // second lock, not the only one). The warning copy in index.html
  // says plainly that memories are erased AND that deleting does not
  // cancel a store subscription.
  const deleteConfirmRow = document.getElementById('accountDeleteConfirm');
  document.getElementById('accountDeleteOpen')?.addEventListener('click', () => {
    setLine('accountDeleteLine', '');
    if (deleteConfirmRow) deleteConfirmRow.style.display = '';
    document.getElementById('accountDeletePassword')?.focus();
  });
  document.getElementById('accountDeleteCancel')?.addEventListener('click', () => {
    if (deleteConfirmRow) deleteConfirmRow.style.display = 'none';
    for (const id of ['accountDeletePassword', 'accountDeleteType']) {
      const el = document.getElementById(id);
      if (el) el.value = '';
    }
    setLine('accountDeleteLine', '');
  });
  document.getElementById('accountDeleteConfirmBtn')?.addEventListener('click', async () => {
    setLine('accountDeleteLine', '');
    const typed = document.getElementById('accountDeleteType')?.value.trim() || '';
    if (typed !== 'DELETE') {
      setLine('accountDeleteLine', 'Type DELETE (all capitals) to confirm — nothing has been deleted.');
      return;
    }
    const password = document.getElementById('accountDeletePassword')?.value || '';
    if (!password) {
      setLine('accountDeleteLine', 'Enter your account password to confirm — nothing has been deleted.');
      return;
    }
    const res = await api('/api/auth/delete-account', { method: 'POST', body: { password } }).catch(() => null);
    if (res && isAccountsOff(res)) { enterLegacyMode(); return; }
    if (res && res.status === 200 && res.data?.deleted) {
      clearSession();
      location.reload();
      return;
    }
    if (res && res.status === 401) {
      setLine('accountDeleteLine', "That password didn't match — nothing was deleted.");
      return;
    }
    setLine('accountDeleteLine', 'Could not delete your account — try again. Nothing was deleted.');
  });

  // Refresh the pane whenever the parent opens the Account tab.
  document.querySelector('.tabs button[data-tab="account"]')
    ?.addEventListener('click', () => { refreshAccountPane(true); });
}

// ─── Boot ───────────────────────────────────────────────────────────────

async function init() {
  wireAccountPane();
  let prof;
  try {
    prof = await api('/api/profile');
  } catch {
    // Server unreachable — never let sign-in UI wedge the app.
    enterLegacyMode();
    return;
  }
  if (isAccountsOff(prof)) { enterLegacyMode(); return; }
  if (prof.status === 401) {
    accountsMode = true;
    if (getToken()) clearSession(); // stale/forged token — start clean
    showAuth();
    return;
  }
  if (prof.status === 200) {
    accountsMode = true;
    profileCache = prof.data;
    await wireBilling(getTenantId() || prof.data?.tenantId);
    refreshAccountPane();
    if (!prof.data?.display_name) showOnboarding();
    return;
  }
  // Anything else: degrade quietly to legacy behaviour.
  enterLegacyMode();
}

init();
