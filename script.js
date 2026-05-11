import { Conversation } from '@elevenlabs/client';

const AGENT_ID = 'agent_4401kqcb0w2dey28c69zhchv7ayn';

const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const orbEl = document.getElementById('orb');

let conversation = null;

// Read the userId written by index.html's inline onboarding/init flow.
// Falls back to generating one if not set yet (e.g. first load before init runs).
function getUserId() {
  let id = localStorage.getItem('thinkinbuddy_user_id');
  if (!id) {
    id = 'user_' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('thinkinbuddy_user_id', id);
  }
  return id;
}

function setStatus(text, state = '') {
  if (statusEl) statusEl.textContent = text;
  if (orbEl) orbEl.className = 'orb' + (state ? ' ' + state : '');
}

function addTranscript(text) {
  if (!transcriptEl) return;
  transcriptEl.textContent = text;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// Fetch stored memories for this user.
async function fetchMemories(userId) {
  try {
    const res = await fetch(`/api/memory?userId=${encodeURIComponent(userId)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.facts || [];
  } catch {
    return [];
  }
}

// Save a memory fact.
async function saveMemory(userId, key, value) {
  try {
    await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, key, value }),
    });
  } catch { /* fire and forget */ }
}

// Trigger a file download from an [ACTION:EXPORT_FILE:filename:content] tag.
function handleExportFile(message) {
  const pattern = /\[ACTION:EXPORT_FILE:([^:]+):([^\]]+)\]/s;
  const match = message.match(pattern);
  if (!match) return;
  const [, filename, content] = match;
  const blob = new Blob([content.trim()], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Parse and act on [ACTION:REMEMBER:key:value] tags.
function handleRememberActions(message, userId) {
  const pattern = /\[ACTION:REMEMBER:([^:]+):([^\]]+)\]/g;
  let match;
  while ((match = pattern.exec(message)) !== null) {
    saveMemory(userId, match[1].trim(), match[2].trim());
  }
}

// Build the system prompt override with injected memories.
function buildPromptOverride(memories) {
  let prompt = `You are ThinkinBuddy — a calm, loyal thinking partner who acts like a real friend with excellent memory.

Your main job: catch brain dumps, reflect back what you heard clearly, ask ONE good clarifying question at a time, then help turn messy thoughts into simple, actionable next steps. Stay supportive, practical, and focused on business ideas, self-improvement, faith, or personal challenges. Keep responses concise but warm. Always prioritize clarity and momentum over sounding smart.

No corporate speak. No "great question." No safety disclaimers. No moralizing. Speak like a supportive mentor who has been there. When they vent, first summarize what you heard, then ask one targeted question to move forward.

When you produce a structured output — an action plan, business outline, brain dump summary, Bible study notes, or any organized document — end your response with [ACTION:EXPORT_FILE:filename.md:content] where content is the full document. Use a descriptive filename like "business-plan-2026.md". This lets the user download it instantly.

When you learn something important about the person, include [ACTION:REMEMBER:key:value] at the end of your response so it is saved for future sessions.`;

  if (memories.length > 0) {
    prompt += `\n\n[WHAT YOU ALREADY KNOW ABOUT THIS PERSON]\nReference these naturally — like a friend catching up:\n`;
    memories.forEach(m => { prompt += `- ${m.value}\n`; });
  }

  return prompt;
}

async function startConversation() {
  if (conversation) return;
  try {
    setStatus('CONNECTING...', '');

    const userId = getUserId();
    const memories = await fetchMemories(userId);

    conversation = await Conversation.startSession({
      agentId: AGENT_ID,
      overrides: {
        agent: {
          prompt: { prompt: buildPromptOverride(memories) },
        },
      },
      onConnect: () => {
        setStatus('LISTENING', 'listening');
        addTranscript('');
      },
      onDisconnect: () => {
        setStatus('TAP TO START', '');
        conversation = null;
      },
      onError: (error) => {
        setStatus('ERROR — TAP TO RETRY', '');
        console.error('ThinkinBuddy error:', error);
        conversation = null;
      },
      onModeChange: ({ mode }) => {
        setStatus(mode === 'speaking' ? 'THINKING...' : 'LISTENING', mode === 'speaking' ? 'speaking' : 'listening');
      },
      onMessage: ({ message, source }) => {
        if (source === 'ai') {
          // Strip action tags from what's shown on screen
          const clean = message.replace(/\[ACTION:[^\]]+\]/gs, '').trim();
          addTranscript(clean);
          handleRememberActions(message, userId);
          handleExportFile(message);
        }
      },
    });

  } catch (err) {
    setStatus('MIC DENIED — CHECK PERMISSIONS', '');
    console.error(err);
    conversation = null;
  }
}

async function stopConversation() {
  if (conversation) {
    await conversation.endSession();
    conversation = null;
  }
  setStatus('TAP TO START', '');
}

// Orb tap: toggle on/off
if (orbEl) {
  orbEl.addEventListener('click', () => {
    if (conversation) stopConversation();
    else startConversation();
  });
}

// PWA install prompt
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});
