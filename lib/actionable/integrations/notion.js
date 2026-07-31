// lib/actionable/integrations/notion.js
// ---------------------------------------------------------------------------
// Notion — the single most-requested destination for voice-capture apps.
// Across published Zapier integration rankings for the three closest comparable
// products (AudioPen, Voicenotes, Cleft), Notion is #1, #1 and #2.
//
// Endpoints (developers.notion.com):
//   authorize  https://api.notion.com/v1/oauth/authorize
//   token      POST https://api.notion.com/v1/oauth/token   (HTTP BASIC auth,
//              base64 "client_id:client_secret" — NOT a bearer, NOT form fields)
//   create     POST https://api.notion.com/v1/pages
//
// No approval is needed to let the public connect — review applies only to being
// listed on Notion's Marketplace.
//
// 🔴 TWO THINGS THAT MAKE THIS HARDER THAN TODOIST, both surfaced before we ship:
//
// 1. UNRESOLVED PAYWALL. notion.com/pricing shows "Public API" with a dash on the
//    Free plan and a check from Plus upward, read twice. Notion's help centre and
//    rate-limit docs imply no such gate, and I could NOT resolve the conflict from
//    primary sources. If the gate is real, this integration only works for PAYING
//    Notion customers. `note` below warns the user rather than letting them find
//    out mid-setup. VERIFY on a free workspace before promoting this.
//
// 2. THERE IS NO INBOX. Notion's consent screen is a PAGE PICKER — the token only
//    reaches pages the user explicitly selected, and nothing tells you which. So
//    after connecting we call /v1/search to find a granted page and store it as
//    the destination. Without that step a push has nowhere to go and 404s.
// ---------------------------------------------------------------------------

import { apiFetch, entryToMarkdown } from './provider.js';

const AUTHORIZE = 'https://api.notion.com/v1/oauth/authorize';
const TOKEN = 'https://api.notion.com/v1/oauth/token';
const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28'; // pinned: Notion breaks on version drift

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': VERSION,
    'Content-Type': 'application/json',
  };
}

export default {
  id: 'notion',
  name: 'Notion',
  blurb: 'Each entry becomes a page in a Notion page you choose.',
  kind: 'oauth',
  accepts: ['task', 'decision', 'idea', 'question', 'blocker', 'purchase', 'note'],
  note:
    'Notion may require a paid Notion plan for API access — their pricing page lists ' +
    'the Public API from the Plus tier up. If you are on Notion Free and this fails, ' +
    'that is why. When connecting, pick the page you want entries filed under.',

  isConfigured() {
    return Boolean(process.env.NOTION_CLIENT_ID && process.env.NOTION_CLIENT_SECRET);
  },

  buildAuthUrl(state) {
    const p = new URLSearchParams({
      client_id: process.env.NOTION_CLIENT_ID,
      response_type: 'code',
      owner: 'user',
      redirect_uri: process.env.NOTION_REDIRECT_URI || '',
      state,
    });
    return `${AUTHORIZE}?${p}`;
  },

  async exchangeCode(code) {
    // Basic auth on the token call — a bearer here returns 401 with a confusing
    // message, which is the classic first-hour Notion mistake.
    const basic = Buffer
      .from(`${process.env.NOTION_CLIENT_ID}:${process.env.NOTION_CLIENT_SECRET}`)
      .toString('base64');

    const json = await apiFetch(TOKEN, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/json',
        'Notion-Version': VERSION,
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.NOTION_REDIRECT_URI || '',
      }),
    }, { label: 'Notion' });

    // Find somewhere to write. Prefer a duplicated template if the user installed
    // one; otherwise take the first page the grant actually covers.
    let parentPageId = json.duplicated_template_id || null;
    if (!parentPageId) {
      try {
        const found = await apiFetch(`${API}/search`, {
          method: 'POST',
          headers: headers(json.access_token),
          body: JSON.stringify({
            filter: { value: 'page', property: 'object' },
            page_size: 1,
          }),
        }, { label: 'Notion' });
        parentPageId = found.results?.[0]?.id || null;
      } catch { /* leave null; push() reports it clearly */ }
    }

    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token || null,
      expires_in: json.expires_in || null,
      account_label: json.workspace_name || 'Notion workspace',
      config: { parentPageId, workspaceId: json.workspace_id || null },
    };
  },

  async push({ entry, items, transcript, accessToken, config }) {
    const parent = config?.parentPageId;
    if (!parent) {
      return {
        ok: false,
        reason: 'No Notion page was shared with Actionable. Reconnect and pick a page to file entries under.',
      };
    }

    const body = entryToMarkdown(entry, items, transcript);

    // Notion caps a text block at 2,000 characters and an array at 100 elements.
    // A long transcript blows straight through the first, so chunk it.
    const chunks = [];
    for (let i = 0; i < body.length && chunks.length < 95; i += 1900) {
      chunks.push(body.slice(i, i + 1900));
    }

    try {
      const page = await apiFetch(`${API}/pages`, {
        method: 'POST',
        headers: headers(accessToken),
        body: JSON.stringify({
          parent: { page_id: parent },
          properties: {
            title: { title: [{ type: 'text', text: { content: entry.title.slice(0, 200) } }] },
          },
          children: chunks.map(text => ({
            object: 'block',
            type: 'paragraph',
            paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
          })),
        }),
      }, { label: 'Notion' });

      return { ok: true, count: 1, url: page.url || null };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  },
};
