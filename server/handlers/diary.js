// Site Diary API
// POST with { text } or { audioBase64, mimeType } (or multipart audio)
// Transcribes audio via OpenAI Whisper, parses with Claude, logs to Google Sheets

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const SHEETS_WEBHOOK = process.env.SHEETS_DIARY_WEBHOOK;

  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    let transcript = req.body?.text || '';

    // If audio came in as base64, transcribe with Whisper
    if (!transcript && req.body?.audioBase64) {
      if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY needed for audio' });
      transcript = await transcribeAudio(req.body.audioBase64, req.body.mimeType || 'audio/webm', OPENAI_KEY);
    }

    if (!transcript || transcript.trim().length < 3) {
      return res.status(400).json({ error: 'No transcription — speak louder or type something' });
    }

    // Parse with Claude
    const parsed = await parseWithClaude(transcript, ANTHROPIC_KEY);

    // Log to Google Sheets via Apps Script webhook (if configured)
    let sheetsResult = null;
    if (SHEETS_WEBHOOK) {
      sheetsResult = await logToSheets(parsed, SHEETS_WEBHOOK);
    }

    return res.status(200).json({
      ok: true,
      transcript,
      parsed,
      logged: !!sheetsResult,
      sheetsRow: sheetsResult?.row || null
    });

  } catch (err) {
    console.error('[diary]', err);
    return res.status(500).json({ error: err.message });
  }
}

async function transcribeAudio(base64, mimeType, openaiKey) {
  // Convert base64 to buffer
  const buf = Buffer.from(base64, 'base64');
  const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';

  // Build multipart form for Whisper
  const boundary = '----WhistlerBoundary' + Date.now();
  const nl = '\r\n';
  let body = '';
  body += `--${boundary}${nl}`;
  body += `Content-Disposition: form-data; name="model"${nl}${nl}`;
  body += `whisper-1${nl}`;
  body += `--${boundary}${nl}`;
  body += `Content-Disposition: form-data; name="language"${nl}${nl}`;
  body += `en${nl}`;
  body += `--${boundary}${nl}`;
  body += `Content-Disposition: form-data; name="file"; filename="audio.${ext}"${nl}`;
  body += `Content-Type: ${mimeType}${nl}${nl}`;

  const preamble = Buffer.from(body, 'utf8');
  const suffix = Buffer.from(`${nl}--${boundary}--${nl}`, 'utf8');
  const full = Buffer.concat([preamble, buf, suffix]);

  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body: full
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Whisper error ${resp.status}: ${txt}`);
  }

  const json = await resp.json();
  return json.text || '';
}

async function parseWithClaude(transcript, apiKey) {
  const today = new Date().toISOString();

  const systemPrompt = `You are a construction site diary assistant.
Extract structured information from a voice note dictated on a job site.
Return ONLY valid JSON matching this schema exactly:
{
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "location": "string (area or location on site, or 'General' if not mentioned)",
  "category": "one of: Safety | Progress | Subcontractor | Material | Weather | Issue | Inspection | General",
  "summary": "one sentence summary",
  "detail": "full description of what was observed or done",
  "action_items": ["array of strings, each a follow-up action"],
  "priority": "Low | Medium | High"
}
Today's datetime is ${today}.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Voice note: "${transcript}"` }]
    })
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Claude error ${resp.status}: ${txt}`);
  }

  const json = await resp.json();
  const raw = json.content?.[0]?.text || '{}';

  // Strip markdown code fences if Claude added them
  const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  try {
    return JSON.parse(clean);
  } catch {
    return { summary: raw, detail: transcript, category: 'General', priority: 'Medium', action_items: [] };
  }
}

async function logToSheets(parsed, webhookUrl) {
  const row = [
    parsed.date || new Date().toISOString().slice(0, 10),
    parsed.time || new Date().toTimeString().slice(0, 5),
    parsed.location || '',
    parsed.category || 'General',
    parsed.priority || 'Medium',
    parsed.summary || '',
    parsed.detail || '',
    (parsed.action_items || []).join(' | ')
  ];

  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ row })
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Sheets webhook error ${resp.status}: ${txt}`);
  }

  return await resp.json().catch(() => ({ ok: true }));
}
