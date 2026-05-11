// api/search.js — web search tool endpoint for ThinkinBuddy.
//
// Called by the ElevenLabs agent when it needs current information.
// Uses Claude's built-in web_search tool to fetch and synthesize results.
// Returns a plain-text summary the agent reads back to the user.
//
// POST body: { query: string }
// Response:  { result: string }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Accept query from body (POST JSON) or URL query string (ElevenLabs webhook)
  const query = req.body?.query || req.query?.query;
  if (!query) return res.status(400).json({ error: 'query required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: 'You are a research assistant. Search the web for the query and return a concise, conversational summary of the most relevant and current information. 2-4 sentences max. No bullet points — this will be read aloud.',
        messages: [{ role: 'user', content: `Search for: ${query}` }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
    });

    const data = await response.json();

    // Extract the text content from the response
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    const result = textBlocks.map(b => b.text).join(' ').trim()
      || 'I searched but could not find a clear answer on that right now.';

    return res.status(200).json({ result });
  } catch (err) {
    console.error('[search] error:', err);
    return res.status(500).json({ result: 'Search failed — try again in a moment.' });
  }
}
