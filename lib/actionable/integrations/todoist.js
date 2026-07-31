// lib/actionable/integrations/todoist.js
// ---------------------------------------------------------------------------
// Todoist — the cleanest OAuth story of every service researched.
//
// WHY IT IS FIRST AFTER GOOGLE: real authorization-code OAuth, no review gate
// standing between you and other people's users, API access explicitly free in
// Doist's own words ("You can use our API for free"), a purpose-built `task:add`
// scope so the consent screen tells the truth, one required field to create a
// task, and 50M+ users.
//
// Endpoints (developer.todoist.com):
//   authorize  https://app.todoist.com/oauth/authorize
//   token      https://api.todoist.com/oauth/access_token
//   create     POST https://api.todoist.com/api/v1/tasks
//
// 🔴 THE ONE SHARP EDGE, and it is sharp: refresh tokens ROTATE on every use.
// Replaying a refresh token outside a ~60 second grace window REVOKES ALL TOKENS
// for that user — a permanent logout, not a retryable error. So two concurrent
// pushes that both decide to refresh will log the user out for good. The
// serialization that prevents this lives in store.js (refreshLock), not here.
// ---------------------------------------------------------------------------

import { apiFetch, itemDueIso } from './provider.js';

const AUTHORIZE = 'https://app.todoist.com/oauth/authorize';
const TOKEN = 'https://api.todoist.com/oauth/access_token';
const API = 'https://api.todoist.com/api/v1';

// Least privilege on purpose. `data:read_write` would also work and would let
// this app read every task the user has — which it has no reason to do, and
// which makes the consent screen alarming for no benefit.
const SCOPE = 'task:add';

export default {
  id: 'todoist',
  name: 'Todoist',
  blurb: 'Send the tasks from a brain dump straight to your Todoist inbox.',
  kind: 'oauth',
  accepts: ['task', 'blocker', 'purchase', 'question'],

  isConfigured() {
    return Boolean(process.env.TODOIST_CLIENT_ID && process.env.TODOIST_CLIENT_SECRET);
  },

  buildAuthUrl(state) {
    const p = new URLSearchParams({
      client_id: process.env.TODOIST_CLIENT_ID,
      scope: SCOPE,
      state,
    });
    return `${AUTHORIZE}?${p}`;
  },

  async exchangeCode(code) {
    const json = await apiFetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.TODOIST_CLIENT_ID,
        client_secret: process.env.TODOIST_CLIENT_SECRET,
        code,
        redirect_uri: process.env.TODOIST_REDIRECT_URI || '',
      }).toString(),
    }, { label: 'Todoist' });

    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token || null,
      expires_in: json.expires_in || null,
      account_label: 'Todoist account',
    };
  },

  async refresh(refreshToken) {
    const json = await apiFetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.TODOIST_CLIENT_ID,
        client_secret: process.env.TODOIST_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    }, { label: 'Todoist' });

    return {
      access_token: json.access_token,
      // Rotation: the NEW refresh token replaces the old one. If the response
      // omits it (the documented 60s grace-window replay), keep what we have —
      // overwriting with null would strand the connection.
      refresh_token: json.refresh_token || refreshToken,
      expires_in: json.expires_in || null,
    };
  },

  async push({ items, accessToken }) {
    let count = 0;
    const failures = [];

    for (const item of items) {
      const body = { content: item.text };
      if (item.detail) body.description = item.detail;

      // Todoist takes a plain YYYY-MM-DD in `due_date`, or a full datetime in
      // `due_datetime`. Send the datetime when a real time was spoken, so a
      // 7 AM reminder does not become an all-day task.
      const iso = itemDueIso(item);
      if (iso) {
        const d = new Date(iso);
        const midnightish = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
        if (midnightish) body.due_date = iso.slice(0, 10);
        else body.due_datetime = iso;
      }

      if (item.priority === 'high') body.priority = 4;       // Todoist p1
      else if (item.priority === 'medium') body.priority = 2; // p3
      if (item.tags?.length) body.labels = item.tags.slice(0, 10);

      try {
        await apiFetch(`${API}/tasks`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            // Todoist honours an idempotency key, so a retried push after a
            // timeout does not create the task twice.
            'X-Request-Id': `actionable-${hash(item.text)}-${iso || 'nodate'}`,
          },
          body: JSON.stringify(body),
        }, { label: 'Todoist' });
        count++;
      } catch (e) {
        failures.push(`${item.text.slice(0, 40)}: ${e.message}`);
      }
    }

    if (!count && failures.length) {
      return { ok: false, reason: failures[0] };
    }
    return {
      ok: true,
      count,
      url: 'https://app.todoist.com/app/today',
      // A partial success must not be reported as a clean one.
      reason: failures.length ? `${failures.length} of ${items.length} did not send` : undefined,
    };
  },
};

// Small stable hash for the idempotency key. Not security-sensitive.
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return Math.abs(h).toString(36);
}
