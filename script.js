import { Conversation } from '@elevenlabs/client';

const AGENT_ID = 'agent_4401kqcb0w2dey28c69zhchv7ayn';

const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const coreBtn = document.getElementById('coreBtn');

let conversation = null;

function setStatus(text, state = '') {
  statusEl.textContent = text;
  document.body.className = state;
}

function addTranscript(text) {
  transcriptEl.textContent = text;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

async function startConversation() {
  try {
    setStatus('CONNECTING...', '');
    startBtn.disabled = true;

    conversation = await Conversation.startSession({
      agentId: AGENT_ID,

      onConnect: () => {
        setStatus('ONLINE — LISTENING', 'listening');
        startBtn.disabled = true;
        stopBtn.disabled = false;
        addTranscript('');
      },

      onDisconnect: () => {
        setStatus('OFFLINE', '');
        startBtn.disabled = false;
        stopBtn.disabled = true;
        conversation = null;
      },

      onError: (error) => {
        setStatus('ERROR — RETRY', '');
        console.error('Jarvis error:', error);
        startBtn.disabled = false;
        stopBtn.disabled = true;
      },

      onModeChange: ({ mode }) => {
        if (mode === 'speaking') {
          setStatus('JARVIS SPEAKING', 'speaking');
        } else {
          setStatus('ONLINE — LISTENING', 'listening');
        }
      },

      onMessage: ({ message, source }) => {
        if (source === 'ai') {
          addTranscript(message);
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
  setStatus('OFFLINE', '');
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
