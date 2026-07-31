// lib/actionable/integrations/registry.js
// ---------------------------------------------------------------------------
// Every supported service, in the order they appear on the Integrations screen.
// Adding a service = write one file next to this one, import it, add it to the
// array. Nothing else in the codebase changes.
//
// ORDER IS THE RESEARCH RESULT, not a preference. Ranked by (demand × how
// easily a normal person can actually use it):
//   1. Google Docs        — universal on Android, and non-sensitive scopes only,
//                           so it ships without a 6-week review or a paid audit.
//   2. Apps Script Docs   — zero setup, works TODAY, no Google Cloud project at
//                           all. This is the path Troy can use tonight.
//   3. Todoist            — best OAuth story of any task app: free API, no review
//                           gate, `task:add` least-privilege scope, 50M+ users.
//   4. Notion             — highest demand of any destination for voice apps, but
//                           an unresolved Free-plan API paywall and a page-picker
//                           consent flow, so it sits below Todoist.
//   5. Make.com           — webhook, free tier, no auth at all.
//   6. Zapier             — same code as Make, but needs a PAID Zapier plan.
//   7. Custom webhook     — n8n / self-hosted / anything.
//
// DELIBERATELY ABSENT, so nobody re-litigates it later:
//   Google Keep    — the API is Workspace-enterprise only and explicitly "not
//                    available to users with personal Google accounts". It is the
//                    biggest note surface on Android and it cannot be shipped.
//   Apple Notes    — no API exists on any platform, by any architecture.
//   Apple Reminders— on-device EventKit only, iOS only. Android-first means zero
//                    addressable users, and it would need a second delivery path
//                    (device-side, offline queue) rather than a server push.
//   Obsidian       — local-first by design; Sync is end-to-end encrypted so that
//                    an API is impossible. The honest feature is markdown export
//                    / share-sheet, not an "integration".
//   Slack          — real and worth building, but it needs its own OAuth app and
//                    an onboarding flow; queued behind the four above.
// ---------------------------------------------------------------------------

import { googleDocs, appsScriptDocs } from './google.js';
import todoist from './todoist.js';
import notion from './notion.js';
import { make, zapier, genericWebhook } from './webhook.js';

export const PROVIDERS = [
  googleDocs,
  appsScriptDocs,
  todoist,
  notion,
  make,
  zapier,
  genericWebhook,
];

const BY_ID = new Map(PROVIDERS.map(p => [p.id, p]));

export function getProvider(id) {
  return BY_ID.get(String(id || '')) || null;
}

// What the Integrations screen renders. Never leaks a secret — `configured`
// tells the app whether the SERVER has this provider's keys, so the button can
// say "Ask Troy to finish setup" instead of failing after a tap.
export function listProviders() {
  return PROVIDERS.map(p => ({
    id: p.id,
    name: p.name,
    blurb: p.blurb,
    kind: p.kind,
    accepts: p.accepts,
    note: p.note || null,
    urlLabel: p.urlLabel || null,
    urlHint: p.urlHint || null,
    docsUrl: p.docsUrl || null,
    configured: (() => { try { return Boolean(p.isConfigured()); } catch { return false; } })(),
  }));
}

// Which providers make sense for a given entry — a task manager should not be
// offered for an entry that produced only notes.
export function providersFor(entry) {
  const kinds = new Set((entry?.items || []).map(i => i.kind));
  return PROVIDERS.filter(p => p.accepts.some(k => kinds.has(k))).map(p => p.id);
}
