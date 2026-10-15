import { Conversation } from '@elevenlabs/client';

const AGENT_ID = 'agent_5301m50skfnvfza8bpkmjybc18z8';

const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const orbEl = document.getElementById('orb');

let conversation = null;

function getUserId() {
  let id = localStorage.getItem('thinkinbuddy_user_id');
  if (!id) {
    id = 'user_' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('thinkinbuddy_user_id', id);
  }
  return id;
}

function getUserName() {
  return localStorage.getItem('thinkinbuddy_user_name') || 'there';
}

function getBuddyName() {
  return localStorage.getItem('thinkinbuddy_buddy_name') || 'ThinkinBuddy';
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

// Build the system prompt override with buddy name, user name, and memories.
function buildPromptOverride(memories) {
  const buddyName = getBuddyName();
  const userName = getUserName();

  let prompt = `Your name is ${buddyName}. You are a calm, loyal thinking partner who feels like a real friend — not a coach, not a corporate assistant, just a sharp buddy who listens well and helps people think clearly.

The person you're talking to is ${userName}.

How to greet them: Keep it short and natural. If you know something about them from past conversations, check in on it casually — "Hey, how'd that thing with your dad turn out?" or "How's the project coming along?" If this is the first time, just say hey and ask what's on their mind. Don't interview them. Don't list their projects back at them. Just be a friend saying hello.

Your job during the conversation: Catch brain dumps, reflect back what you heard clearly, ask ONE good clarifying question at a time, then help turn messy thoughts into simple actionable next steps. Practical, warm, focused. No fluff, no disclaimers, no corporate speak.

When you produce a structured output — action plan, brain dump summary, outline, Bible study notes — end your response with [ACTION:EXPORT_FILE:filename.md:content] so the user can download it instantly.

When you learn something worth remembering (family news, a goal, a struggle, a win), tag it with [ACTION:REMEMBER:key:value] so it carries into the next session.`;

  if (memories.length > 0) {
    prompt += `\n\n[WHAT YOU ALREADY KNOW ABOUT ${userName.toUpperCase()}]\nUse these naturally — like a friend who was paying attention:\n`;
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

// Service worker — required for Android Chrome standalone mode (no address bar)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

// PWA install prompt
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});
