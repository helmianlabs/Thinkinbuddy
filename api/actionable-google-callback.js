// api/actionable-google-callback.js
// ---------------------------------------------------------------------------
// Google redirects the browser here after consent. This is the value that goes
// in GOOGLE_OAUTH_REDIRECT_URI and in the Cloud Console's "Authorized redirect
// URIs" list — the two must match EXACTLY, including https and any trailing
// path, or Google refuses with redirect_uri_mismatch before the user sees a
// consent screen.
//
// Responds with a plain HTML page rather than JSON: a human is looking at this
// in a browser, having just tapped a button in the app.
// ---------------------------------------------------------------------------

import { exchangeCode, saveGoogleAccount, readState } from '../lib/actionable/google-auth.js';

export default async function handler(req, res) {
  const { code, error, state } = req.query || {};

  if (error) return html(res, 400, 'Connection cancelled', `Google reported: ${escapeHtml(String(error))}`, false);
  if (!code) return html(res, 400, 'Missing authorization code', 'Google did not send a code. Start the connection again from the app.', false);

  try {
    // Verify the signed state BEFORE spending an authorization code. This is what
    // stops a forged callback binding an attacker's Google account to Troy's user id.
    const userId = readState(state);

    const tokens = await exchangeCode(code);
    if (!tokens.refresh_token) {
      // Without a refresh token the connection dies silently in ~1 hour. Better
      // to fail now, visibly, with the fix.
      return html(res, 400, 'Google did not return a refresh token',
        'This usually means the account was already connected once. Remove access at ' +
        'myaccount.google.com → Security → Third-party apps, then connect again.', false);
    }

    const { email } = await saveGoogleAccount(userId, tokens);
    return html(res, 200, 'Connected',
      `Actionable can now write to Google Docs${email ? ` as <strong>${escapeHtml(email)}</strong>` : ''}.<br><br>You can close this tab and go back to the app.`, true);

  } catch (err) {
    console.error('[actionable-google-callback]', err);
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
