// lib/actionable/integrations/google.js
// ---------------------------------------------------------------------------
// Two ways to get entries into Google Docs, and they are NOT the same mechanism.
// Confusing them is the single most common misunderstanding here, so:
//
//   googleDocs  (kind 'oauth')  — a real Google Cloud OAuth client. The USER
//     approves on Google's screen and documents land in THEIR Drive. This is what
//     a shipped, public app needs. It requires Troy to create a Cloud project.
//
//   appsScriptDocs (kind 'script') — a Google Apps Script web app the user
//     deploys themselves, set to "Execute as: Me". It runs AS THAT PERSON, so
//     there is no OAuth client, no consent screen and no verification — which is
//     exactly why it works today with zero setup.
//
// 🔴 THE ANSWER TO TROY'S QUESTION, established by reading the code rather than
// guessing: his Claude AI Memory Vault uses the SECOND mechanism. Its config is
// `DOCS_WEBHOOK_URL` (claude-ai-memory-vault/.env.example:15), pointing at a
// deployed Apps Script (`google-docs/DEPLOY_GUIDE.md:5-11`, "Execute as: Me").
// There is NO reusable Google OAuth client in that project — the `extras/oauth-pro`
// folder is OAuth for the MCP server itself, not for Google.
//
// So: he cannot "switch over" a Google OAuth client, because he never had one.
// BUT he does not have to redo anything either — the /exec URL he already
// deployed accepts exactly `{ title, content }` and returns `{ url }`
// (PushToDocs.gs:17-21), which is byte-for-byte the contract this provider
// speaks. He pastes that existing URL into Actionable and it works immediately.
// ---------------------------------------------------------------------------

import { renderDoc, writeGoogleDoc, writeDocViaWebhook } from '../docs.js';
import { buildAuthUrl, exchangeCode as gExchange, refreshAccessToken, isGoogleConfigured, SCOPES } from '../google-auth.js';

const ACCEPTS = ['task', 'decision', 'idea', 'question', 'blocker', 'purchase', 'note'];

export const googleDocs = {
  id: 'google-docs',
  name: 'Google Docs',
  blurb: 'Every entry becomes a formatted document in your Google Drive.',
  kind: 'oauth',
  accepts: ACCEPTS,
  scopes: SCOPES,
  note:
    'Only asks for permission to files this app creates — it cannot see anything ' +
    'else in your Drive.',

  isConfigured: () => isGoogleConfigured(),
  buildAuthUrl: (state) => buildAuthUrl(state),
  exchangeCode: (code) => gExchange(code),
  refresh: (rt) => refreshAccessToken(rt),

  // Google is the one provider whose tokens predate this interface, so its push
  // delegates to the existing, already-proven writer rather than duplicating it.
  async push({ userId, entry, items, transcript, timezone, capturedAt, projects, folderId }) {
    const subset = { ...entry, items };
    const out = await writeGoogleDoc(userId, subset, {
      transcript, timezone, capturedAt, projects, folderId,
    });
    if (!out.ok) return { ok: false, reason: out.reason === 'not_connected' ? 'Google is not connected.' : out.reason };
    return { ok: true, count: 1, url: out.url };
  },
};

export const appsScriptDocs = {
  id: 'apps-script-docs',
  name: 'Google Docs (your own script)',
  blurb: 'No Google sign-in needed. Uses a small script you deploy once, under your own account.',
  kind: 'script',
  accepts: ACCEPTS,
  urlLabel: 'Your Apps Script /exec URL',
  urlHint: 'https://script.google.com/macros/s/AKfy.../exec',
  docsUrl: 'https://script.google.com',
  note:
    'If you already deployed the PushToDocs script for Claude AI Memory Vault, paste ' +
    'that SAME /exec URL here — it takes the identical request and it will just work. ' +
    'Otherwise deploy it once (Execute as: Me, Who has access: Anyone) and paste the URL.',

  isConfigured: () => true,

  async push({ entry, items, transcript, timezone, capturedAt, projects, targetUrl }) {
    if (!targetUrl) return { ok: false, reason: 'No script URL has been set.' };
    const subset = { ...entry, items };
    try {
      const out = await writeDocViaWebhook(targetUrl, subset, {
        transcript, timezone, capturedAt, projects,
      });
      return { ok: true, count: 1, url: out.url || null };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  },
};

export { renderDoc };
