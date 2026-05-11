// api/llm.js — OpenAI-compatible LLM endpoint for ElevenLabs Custom LLM.
//
// ElevenLabs sends the conversation in OpenAI chat format and expects a
// streaming OpenAI-format response. This endpoint:
//   1. Translates OpenAI messages → Anthropic format
//   2. Calls Claude Sonnet with the web_search tool enabled
//   3. Streams the response back in OpenAI SSE format
//
// Configure in ElevenLabs agent settings:
//   LLM → Custom LLM → URL: https://jarvis-troy.vercel.app/api/llm
//
// The system prompt (with memories + buddy name) arrives via the
// overrides injected by script.js — no extra server-side memory fetch needed.

export const config = { maxDuration: 60 }; // Vercel max for streaming

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1024;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { messages = [] } = req.body || {};

  // ── Split system vs conversation messages ────────────────────────────────
  const systemParts = messages
    .filter(m => m.role === 'system')
    .map(m => (typeof m.content === 'string' ? m.content : extractText(m.content)))
    .filter(Boolean);

  const conversationMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content : extractText(m.content),
    }))
    .filter(m => m.content);

  const systemPrompt = systemParts.join('\n\n') || 'You are a helpful assistant.';

  // ── Call Claude with web_search ──────────────────────────────────────────
  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: conversationMessages.length ? conversationMessages : [{ role: 'user', content: 'Hello' }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        stream: true,
      }),
    });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Anthropic API', detail: String(err) });
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text().catch(() => '');
    return res.status(anthropicRes.status).json({ error: 'Anthropic error', detail: errText.slice(0, 300) });
  }

  // ── Stream Anthropic SSE → OpenAI SSE ───────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const chatId = 'chatcmpl-' + Date.now();
  const reader = anthropicRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  function sendChunk(text) {
    if (!text) return;
    const chunk = {
      id: chatId,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  function sendDone() {
    const chunk = {
      id: chatId,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write('data: [DONE]\n\n');
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // keep incomplete last line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;

        let event;
        try { event = JSON.parse(raw); } catch { continue; }

        // Only forward text content — tool_use blocks are handled by Anthropic
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          event.delta.text
        ) {
          sendChunk(event.delta.text);
        }

        if (event.type === 'message_stop') {
          sendDone();
        }
      }
    }
  } catch (err) {
    console.error('[llm] stream error:', err);
  } finally {
    res.end();
  }
}

// Extract plain text from an OpenAI content array
function extractText(content) {
  if (!Array.isArray(content)) return String(content || '');
  return content
    .filter(c => c.type === 'text')
    .map(c => c.text || '')
    .join('');
}
