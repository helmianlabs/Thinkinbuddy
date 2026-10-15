// api/actionable-oauth-callback.js
// ---------------------------------------------------------------------------
// One callback for every OAuth provider EXCEPT Google, which keeps its own
// route (api/actionable-google-callback.js) because its redirect URI is already
// registered and working.
//
// Which provider a code belongs to comes from the SIGNED state, never from a
// query parameter. A `?provider=` the caller controls would let someone feed a
// code issued by one service into another service's token exchange.
//
// Register this URL in each service's developer console:
//   https://thinkinbuddy.vercel.app/api/actionable-oauth-callback
// ---------------------------------------------------------------------------

import { readStateFull } from '../../lib/actionable/google-auth.js';
import { getProvider } from '../../lib/actionable/integrations/registry.js';
import { saveConnection } from '../../lib/actionable/integrations/store.js';

export default async function handler(req, res) {
  const { code, error, state, error_description } = req.query || {};

  if (error) {
    return html(res, 400, 'Connection cancelled',
      escapeHtml(String(error_description || error)), false);
  }
  if (!code) {
    return html(res, 400, 'Missing authorization code',
      'No code came back. Start the connection again from the app.', false);
  }

  try {
    const { userId, provider: providerId } = readStateFull(state);
    const provider = getProvider(providerId);
    if (!provider || provider.kind !== 'oauth') {
      return html(res, 400, 'Unknown service',
        `The state pointed at "${escapeHtml(String(providerId))}", which is not a service that signs in.`, false);
    }

    const tokens = await provider.exchangeCode(code);
    if (!tokens?.access_token) {
      return html(res, 502, 'No access token',
        `${escapeHtml(provider.name)} completed sign-in but returned no access token.`, false);
    }

    await saveConnection(userId, provider.id, tokens);

    return html(res, 200, 'Connected',
      `Actionable is now connected to <strong>${escapeHtml(provider.name)}</strong>` +
      `${tokens.account_label ? ` (${escapeHtml(tokens.account_label)})` : ''}.` +
      '<br><br>You can close this tab and go back to the app.', true);

  } catch (err) {
    console.error('[actionable-oauth-callback]', err);
    return html(res, 500, 'Connection failed', escapeHtml(err.message), false);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function html(res, status, heading, body, ok) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(status).send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(heading)} · Actionable</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f1a;color:#e0e0f0;
       display:flex;align-items:center;justify-content:center;min-height:100dvh;margin:0;padding:24px;text-align:center}
  .card{max-width:420px;background:#1e1e30;border:1px solid #2d2d44;border-radius:14px;padding:28px}
  h1{font-size:20px;margin:0 0 12px;color:${ok ? '#22c55e' : '#ef4444'}}
  p{font-size:15px;line-height:1.55;color:#c7c7d9;margin:0}
</style></head>
<body><div class="card"><h1>${ok ? '✓ ' : ''}${escapeHtml(heading)}</h1><p>${body}</p></div></body></html>`);
}
