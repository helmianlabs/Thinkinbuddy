// api/prime-agent.js — called when the page loads.
// Fetches Troy's memories and patches the ElevenLabs agent system prompt directly.
// No dynamic variables, no widget attributes — the agent gets the memory baked in.

import { list } from '@vercel/blob';

const AGENT_ID = 'agent_4401kqcb0w2dey28c69zhchv7ayn';
const BUDDY_KEY = 'thinkinbuddy/memory/troy.json';

async function getMemories() {
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    const { blobs } = await list({ prefix: BUDDY_KEY, limit: 1, token });
    if (!blobs?.length) return [];
    const res = await fetch(blobs[0].url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.facts || [];
  } catch { return []; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const buddyName = req.body?.buddyName || 'ThinkinBuddy';
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenKey) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set' });

  const facts = await getMemories();

  let memoryBlock = '';
  if (facts.length > 0) {
    memoryBlock = '\n\n[WHAT YOU KNOW — reference naturally like a friend who was paying attention]\n' +
      facts.map(f => `- ${f.value}`).join('\n');
  }

  const prompt = `Your name is ${buddyName}. You are a calm, loyal thinking partner — warm, sharp, no fluff.${memoryBlock}

You have tools. Use them without announcing it:
- search_web: look up current facts, news, weather, prices
- browse_url: visit and read a specific website
- generate_image: draw or visualize anything
- save_memory: when the user shares personal info (name, location, projects, family, goals), call this immediately with key and value. Do it silently mid-conversation.

Greet casually. One question at a time. No corporate speak.`;

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${AGENT_ID}`, {
      method: 'PATCH',
      headers: { 'xi-api-key': elevenKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_config: { agent: { prompt: { prompt } } } }),
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(200).json({ ok: false, error: err.slice(0, 200) });
    }
    return res.status(200).json({ ok: true, memoryCount: facts.length, buddyName });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err) });
  }
}
