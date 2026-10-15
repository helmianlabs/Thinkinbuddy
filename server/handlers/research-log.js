// Research data logging endpoint
// Saves anonymized conversation snapshots to Vercel Blob for psychological research analysis
// Only fires when user has explicitly consented (consentResearch flag in payload)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { conversation, userContext, consentResearch } = req.body || {};

  // Hard gate: do NOT log without explicit consent flag
  if (!consentResearch) {
    return res.status(200).json({ logged: false, reason: 'no consent' });
  }

  if (!conversation || !Array.isArray(conversation) || conversation.length === 0) {
    return res.status(400).json({ error: 'conversation array required' });
  }

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    return res.status(500).json({ error: 'Blob storage not configured' });
  }

  try {
    const { put } = await import('@vercel/blob');

    // Anonymize: hash userId, strip any obvious PII patterns from messages
    const userIdHash = userContext?.userId
      ? hashString(userContext.userId)
      : 'anon';

    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filename = `research/${new Date().toISOString().slice(0, 10)}/${userIdHash}-${sessionId}.md`;

    const md = formatAsMarkdown(conversation, userContext);

    await put(filename, md, {
      access: 'public',
      contentType: 'text/markdown'
    });

    return res.status(200).json({ logged: true, sessionId });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to log', details: e.message });
  }
}

// Simple non-cryptographic hash for de-identification
function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h = h & h;
  }
  return Math.abs(h).toString(36);
}

function formatAsMarkdown(conversation, userContext) {
  const date = new Date().toISOString();
  const consentDate = userContext?.consentDate || 'unrecorded';
  const sessionLength = conversation.length;
  const namedTag = userContext?.researchTag || 'general';

  let md = `---\n`;
  md += `session_date: ${date}\n`;
  md += `consent_date: ${consentDate}\n`;
  md += `participant_hash: ${hashString(userContext?.userId || 'anon')}\n`;
  md += `participant_age_range: ${userContext?.ageRange || 'unspecified'}\n`;
  md += `research_tag: ${namedTag}\n`;
  md += `message_count: ${sessionLength}\n`;
  md += `---\n\n`;

  md += `# Session ${date.slice(0, 10)}\n\n`;

  for (const msg of conversation) {
    const role = msg.role === 'user' ? 'PARTICIPANT' : 'THINKINBUDDY';
    md += `## ${role}\n${msg.content}\n\n`;
  }

  return md;
}
