// api/actionable-auth.js
// ---------------------------------------------------------------------------
// The "Connect Google Docs" button, server side.
//
//   GET    ?userId=troy&action=status   → { connected, email, configured }
//   GET    ?userId=troy&action=start    → { authUrl }  (app opens it in a browser)
//   DELETE ?userId=troy                 → revoke at Google + delete locally
//
// The app never sees a token. It opens authUrl, Google redirects to
// api/actionable-google-callback, and the app polls `status` until connected.
// ---------------------------------------------------------------------------

import {
  buildAuthUrl, googleStatus, disconnectGoogle, isGoogleConfigured, SCOPES,
} from '../lib/actionable/google-auth.js';
import { cors, requireAuth, readQuery } from '../lib/actionable/http.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!requireAuth(req, res)) return;

  const userId = readQuery(req, 'userId') || req.body?.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    if (req.method === 'DELETE') {
      await disconnectGoogle(userId);
      return res.status(200).json({ ok: true, connected: false });
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'GET or DELETE only' });

    const action = readQuery(req, 'action', 'status');

    if (action === 'start') {
      if (!isGoogleConfigured()) {
        // A specific, actionable message. "Not configured" alone sends someone
        // hunting through a dashboard with no idea which of three values is missing.
        return res.status(503).json({
          error: 'Google is not set up on the server yet.',
          missing: [
            !process.env.GOOGLE_OAUTH_CLIENT_ID && 'GOOGLE_OAUTH_CLIENT_ID',
            !process.env.GOOGLE_OAUTH_CLIENT_SECRET && 'GOOGLE_OAUTH_CLIENT_SECRET',
            !process.env.GOOGLE_OAUTH_REDIRECT_URI && 'GOOGLE_OAUTH_REDIRECT_URI',
          ].filter(Boolean),
          setupGuide: 'docs/ACTIONABLE_SETUP.md',
        });
      }
      if (!process.env.ACTIONABLE_STATE_SECRET) {
        return res.status(503).json({
          error: 'ACTIONABLE_STATE_SECRET is not set — it signs the OAuth state parameter and is required.',
          setupGuide: 'docs/ACTIONABLE_SETUP.md',
        });
      }
      return res.status(200).json({ ok: true, authUrl: buildAuthUrl(userId), scopes: SCOPES });
    }

    const status = await googleStatus(userId);
    return res.status(200).json({ ok: true, configured: isGoogleConfigured(), ...status });

  } catch (err) {
    console.error('[actionable-auth]', err);
    return res.status(500).json({ error: err.message });
  }
}
