import { Conversation } from '@elevenlabs/client';

const AGENT_ID = 'agent_4401kqcb0w2dey28c69zhchv7ayn';

const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const coreBtn = document.getElementById('coreBtn');

let conversation = null;

// Simple user ID — persisted in localStorage so memories survive sessions.
function getUserId() {
  let id = localStorage.getItem('thinkinbuddy_user_id');
  if (!id) {
    id = 'user_' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('thinkinbuddy_user_id', id);
  }
  return id;
}

function setStatus(text, state = '') {
  statusEl.textContent = text;
  document.body.className = state;
}

function addTranscript(text) {
  transcriptEl.textContent = text;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// Fetch stored memories for this user from our memory API.
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

// Save a memory fact when ThinkinBuddy detects something worth keeping.
async function saveMemory(userId, key, value) {
  try {
    await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, key, value }),
    });
  } catch {
    // fire and forget — don't interrupt the conversation
  }
}

// Parse [ACTION:REMEMBER:key:value] tags from AI messages and persist them.
function handleRememberActions(message, userId) {
  const pattern = /\[ACTION:REMEMBER:([^:]+):([^\]]+)\]/g;
  let match;
  while ((match = pattern.exec(message)) !== null) {
    const [, key, value] = match;
    saveMemory(userId, key.trim(), value.trim());
  }
}

// Build the system prompt override with injected memories.
function buildPromptOverride(memories) {
  let prompt = `You are ThinkinBuddy — a calm, loyal thinking partner who acts like a real friend with excellent memory.

Your main job: catch brain dumps, reflect back what you heard clearly, ask ONE good clarifying question at a time, then help turn messy thoughts into simple, actionable next steps. Stay supportive, practical, and focused on business ideas, self-improvement, faith, or personal challenges. Keep responses concise but warm. Always prioritize clarity and momentum over sounding smart.

No corporate speak. No "great question." No safety disclaimers. No moralizing. Speak like a supportive mentor who has been there. When they vent, first summarize what you heard, then ask one targeted question to move forward.

When you learn something important about the person — family news, a goal, a struggle, a win — naturally include [ACTION:REMEMBER:key:value] at the end of your response so it is saved for future sessions. Keep the key short (e.g. "dad_health", "main_project", "big_goal").`;

  if (memories.length > 0) {
    prompt += `\n\n[WHAT YOU ALREADY KNOW ABOUT THIS PERSON]\nReference these naturally — like a friend catching up, not reading a file:\n`;
    memories.forEach(m => {
      prompt += `- ${m.value}\n`;
    });
  }

  return prompt;
}

async function startConversation() {
  try {
    setStatus('CONNECTING...', '');
    startBtn.disabled = true;

    const userId = getUserId();
    const memories = await fetchMemories(userId);

    conversation = await Conversation.startSession({
      agentId: AGENT_ID,

      // Inject memories into the agent's system prompt for this session.
      overrides: {
        agent: {
          prompt: {
            prompt: buildPromptOverride(memories),
          },
        },
      },

      onConnect: () => {
        setStatus('LISTENING', 'listening');
        startBtn.disabled = true;
        stopBtn.disabled = false;
        addTranscript('');
      },

      onDisconnect: () => {
        setStatus('TAP TO START', '');
        startBtn.disabled = false;
        stopBtn.disabled = true;
        conversation = null;
      },

      onError: (error) => {
        setStatus('ERROR — TAP TO RETRY', '');
        console.error('ThinkinBuddy error:', error);
        startBtn.disabled = false;
        stopBtn.disabled = true;
      },

      onModeChange: ({ mode }) => {
        if (mode === 'speaking') {
          setStatus('THINKING...', 'speaking');
        } else {
          setStatus('LISTENING', 'listening');
        }
      },

      onMessage: ({ message, source }) => {
        if (source === 'ai') {
          addTranscript(message);
          // Silently save any memory tags the AI included
          handleRememberActions(message, userId);
        }
      },
    });

  } catch (err) {
    setStatus('MIC DENIED — CHECK PERMISSIONS', '');
    startBtn.disabled = false;
    console.error(err);
  }
}

async function stopConversation() {
  if (conversation) {
    await conversation.endSession();
    conversation = null;
  }
  setStatus('TAP TO START', '');
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

startBtn.addEventListener('click', startConversation);
stopBtn.addEventListener('click', stopConversation);
coreBtn.addEventListener('click', () => {
  if (!conversation) startConversation();
  else stopConversation();
});

// PWA install
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});
