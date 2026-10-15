// api/browse.js — fetch a URL and return readable text content.
//
// Called by the ElevenLabs agent when the user asks it to visit a website.
// Fetches the page, strips HTML tags, returns clean readable text.
//
// POST body: { url: string }
// GET param: ?url=...
// Response:  { result: string }
//
// Kid-safe: refuses adult/unsafe domains (Layer 3 denylist) up front, and
// moderates the fetched page's main text (Layer 2) before returning it.

import { isSafeUrl, UNSAFE_SITE_MSG } from '../../lib/safeBrowse.js';
import { isAllowed } from '../../lib/moderation.js';
import { requireToolAuth } from '../../lib/security.js';
import { completeText, hasTextLlm } from '../../lib/llm.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Spends OPENAI_API_KEY (moderation, :74) then ANTHROPIC_API_KEY (:80), and
  // additionally fetches an arbitrary attacker-supplied URL from Vercel's
  // network. Had no gate: `POST {}` returned 400 "url required" from anywhere.
  //
  // NO-OP UNTIL ENFORCE_TOOL_AUTH=1 — see lib/security.js:requireToolAuth.
  if (!requireToolAuth(req, res)) return;

  const url = req.body?.url || req.query?.url;
  if (!url) return res.status(400).json({ error: 'url required' });

  // Basic URL validation
  let target;
  try {
    target = new URL(url.startsWith('http') ? url : 'https://' + url);
  } catch {
    return res.status(400).json({ error: 'invalid url' });
  }

  // Layer 3 — refuse adult/unsafe destinations BEFORE fetching.
  const urlSafe = isSafeUrl(target.toString());
  if (!urlSafe.safe) {
    console.warn('[browse] blocked unsafe url:', target.hostname, urlSafe.reason);
    return res.status(200).json({ result: UNSAFE_SITE_MSG });
  }

  try {
    const response = await fetch(target.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ThinkinBuddy/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return res.status(200).json({
        result: `The page at ${target.toString()} returned an error (${response.status}). It may require login or block automated access.`
      });
    }

    const html = await response.text();

    // Strip HTML to get readable text
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#\d+;/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 4000); // cap at 4k chars so the agent can digest it

    // Layer 2 — moderate the page's main text (first ~2000 chars) so a
    // safe-looking domain serving unsafe content still gets refused.
    const pageMod = await isAllowed(text.slice(0, 2000), process.env.OPENAI_API_KEY);
    if (!pageMod.allowed) {
      console.warn('[browse] page content blocked by moderation:', target.hostname, pageMod.reason);
      return res.status(200).json({ result: UNSAFE_SITE_MSG });
    }

    if (!hasTextLlm(req)) {
      return res.status(200).json({ result: text.slice(0, 500) });
    }

    // Summarize with Gemini (free) or Anthropic — speakable aloud
    let result;
    try {
      result = await completeText({
        req,
        maxTokens: 300,
        system: 'Summarize this webpage content in 3-5 conversational sentences as if you just read it. Focus on what the site is about, what it offers, and your honest impression. No bullet points — this will be read aloud.',
        user: `URL: ${target.toString()}

Page content:
${text}`,
      });
    } catch {
      result = text.slice(0, 300);
    }

    return res.status(200).json({ result });
  } catch (err) {
    console.error('[browse] error:', err);
    return res.status(200).json({
      result: `I had trouble loading ${url}. The site may be blocking automated access or is down.`
    });
  }
}
