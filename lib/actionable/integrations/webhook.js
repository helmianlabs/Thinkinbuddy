// lib/actionable/integrations/webhook.js
// ---------------------------------------------------------------------------
// One code path, three products: Zapier, Make.com, and n8n (plus anything else
// that accepts a POST).
//
// WHY NOT BUILD A PUBLISHED ZAPIER APP: Zapier's publishing requirements demand
// that you own the API you integrate and that the app be publicly launched,
// followed by a MANDATORY 90-day beta. Make's custom-app path is lighter but
// still more work than it is worth. Meanwhile a Catch Hook URL needs no auth, no
// registration and no review — the URL IS the credential. For a small app that
// is not a shortcut, it is the correct engineering trade.
//
// 🔴 ZAPIER COSTS THE USER MONEY, AND WE SAY SO IN THE UI. "Webhooks by Zapier"
// is a premium app: Zapier's own plan tables show Free ✗ / Professional ✓, so a
// user needs a paid Zapier plan (~$20-30/mo) for this to work at all. Letting
// someone wire it up and discover the paywall mid-setup is how you earn a
// one-star review you did not deserve, so `note` below is shown BEFORE they
// connect. Make.com appears to have no equivalent premium gate.
// ---------------------------------------------------------------------------

import { apiFetch, entryToMarkdown } from './provider.js';

// A shared push implementation — the three entries below differ only in the
// words shown to the user.
async function postJson({ entry, items, transcript, targetUrl, capturedAt }, label) {
  if (!targetUrl || !/^https:\/\//i.test(targetUrl)) {
    return { ok: false, reason: 'That does not look like a valid https:// URL.' };
  }

  // A flat, stable payload. Automation tools infer their field mapping from the
  // FIRST payload they receive, so changing this shape later silently breaks
  // every Zap and scenario already built on it. Treat it as a public contract.
  const payload = {
    source: 'actionable',
    captured_at: new Date(capturedAt).toISOString(),
    title: entry.title,
    summary: entry.summary,
    markdown: entryToMarkdown(entry, items, transcript),
    transcript,
    people: entry.people,
    item_count: items.length,
    items: items.map(i => ({
      kind: i.kind,
      text: i.text,
      detail: i.detail,
      project: i.project,
      tags: i.tags,
      priority: i.priority,
      due: i.due?.iso || null,
      due_spoken: i.due?.raw || null,
    })),
    numbers: entry.numbers,
    open_questions: entry.open_questions,
  };

  try {
    await apiFetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, { label, timeoutMs: 15_000 });
    return { ok: true, count: items.length };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

const ACCEPTS = ['task', 'decision', 'idea', 'question', 'blocker', 'purchase', 'note'];

export const zapier = {
  id: 'zapier',
  name: 'Zapier',
  blurb: 'Send every entry into a Zap, then on to any of 8,000+ apps.',
  kind: 'url',
  accepts: ACCEPTS,
  urlLabel: 'Your Zapier Catch Hook URL',
  urlHint: 'https://hooks.zapier.com/hooks/catch/1234567/abcdef/',
  docsUrl: 'https://zapier.com/apps/webhook/integrations',
  note:
    'Zapier requires a PAID Zapier plan for webhooks — "Webhooks by Zapier" is one of ' +
    'their premium apps and is not on the free tier. If you are on Zapier Free this will ' +
    'not fire. Make.com below does the same job and appears to work on its free plan.',
  isConfigured: () => true,   // nothing to configure server-side
  push: (ctx) => postJson(ctx, 'Zapier'),
};

export const make = {
  id: 'make',
  name: 'Make.com',
  blurb: 'Send every entry into a Make scenario. Free plan works.',
  kind: 'url',
  accepts: ACCEPTS,
  urlLabel: 'Your Make Custom Webhook URL',
  urlHint: 'https://hook.eu2.make.com/abc123...',
  docsUrl: 'https://www.make.com/en/integrations/gateway',
  note:
    'Add a "Custom webhook" module in Make, copy the URL it generates, and paste it here. ' +
    'Make\'s free plan includes 1,000 operations a month and 2 active scenarios.',
  isConfigured: () => true,
  push: (ctx) => postJson(ctx, 'Make.com'),
};

export const genericWebhook = {
  id: 'webhook',
  name: 'Custom webhook',
  blurb: 'POST every entry as JSON to any URL you control. For n8n, or your own server.',
  kind: 'url',
  accepts: ACCEPTS,
  urlLabel: 'Your endpoint URL',
  urlHint: 'https://your-server.com/hooks/actionable',
  note: 'Receives a JSON POST. The `items` array is the useful part.',
  isConfigured: () => true,
  push: (ctx) => postJson(ctx, 'your webhook'),
};
