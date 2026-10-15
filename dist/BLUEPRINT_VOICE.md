# The Voice Diary Blueprint
### Speak → Transcribe → Structure → Google Sheets. Automatically.

**Tap a button on your phone. Talk. See a structured row appear in your spreadsheet.**

---

## What This Solves

You're driving, walking the job site, or just don't want to type. You have an idea, a task, a site note, a meeting recap. By the time you're at a keyboard, it's gone or garbled.

This blueprint builds a mobile-first Progressive Web App (PWA) you add to your phone's home screen. Tap the mic. Speak naturally. It:

1. Transcribes your audio (OpenAI Whisper)
2. Structures it with AI (Claude Haiku — parses date, time, location, category, priority, summary, action items)
3. Logs a clean row to your Google Sheet automatically

No app store. No subscription. No account to create. Just a URL you bookmark or add to your home screen.

---

## What You Get

- **`api/diary.js`** — complete serverless backend (Whisper → Claude Haiku → Google Sheets webhook)
- **`diary.html`** — mobile-first dark UI with a 140px tap-to-record button
- **Google Apps Script webhook** — one script, deployed in 2 minutes, logs rows to any Sheet
- Env var setup commands (no carriage-return gotchas)
- `vercel --prod` deployment walkthrough
- "Add to Home Screen" instructions for iOS and Android

**Stack:** Vercel (free), OpenAI Whisper API, Claude Haiku, Google Sheets  
**Running cost:** Pennies per voice note (~$0.006 per minute of audio, ~$0.0005 per Haiku call)  
**Time to working:** ~20 minutes

---

## How It Works

```
Your phone mic
     ↓
diary.html (PWA — runs in browser, saved to home screen)
     ↓  POSTs audio as base64
api/diary.js (Vercel serverless)
     ↓  Whisper API
Transcription text
     ↓  Claude Haiku
Structured JSON { date, time, location, category, priority, summary, detail, action_items }
     ↓  POST to Google Apps Script /exec URL
Google Sheets row appended
     ↓
diary.html shows you the parsed result
```

---

## Step 1: Set Up Google Sheets + Apps Script Webhook

1. Create a new Google Sheet (or use an existing one)
2. Open **Extensions → Apps Script**
3. Delete the default `myFunction()` and paste this:

```javascript
function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  var ss = SpreadsheetApp.openById('YOUR_SPREADSHEET_ID_HERE');
  var sheet = ss.getActiveSheet();
  
  // Add headers on first row if empty
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Date', 'Time', 'Location', 'Category', 'Priority', 'Summary', 'Detail', 'Action Items', 'Transcript']);
  }
  
  sheet.appendRow(data.row);
  
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

4. Replace `YOUR_SPREADSHEET_ID_HERE` with the ID from your Sheet's URL:
   `https://docs.google.com/spreadsheets/d/**THIS_PART**/edit`

5. Click **Deploy → New deployment**
   - Type: **Web App**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click Deploy → copy the `/exec` URL

This URL is your `SHEETS_DIARY_WEBHOOK` env var.

---

## Step 2: Create api/diary.js

In your Vercel project, create a folder called `api/` and put this file inside it:

```javascript
export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

async function transcribeAudio(audioBase64, mimeType) {
  const blob = new Blob([Buffer.from(audioBase64, 'base64')], { type: mimeType });
  const form = new FormData();
  form.append('file', blob, 'audio.webm');
  form.append('model', 'whisper-1');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form
  });

  if (!res.ok) throw new Error(`Whisper error: ${await res.text()}`);
  return (await res.json()).text;
}

async function parseWithClaude(transcript) {
  const today = new Date().toISOString().split('T')[0];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Parse this voice note into JSON only. No markdown. No explanation.

{
  "date": "YYYY-MM-DD (today is ${today} if not specified)",
  "time": "HH:MM or 'unspecified'",
  "location": "location mentioned or 'unspecified'",
  "category": "one of: business-idea | task | reflection | meeting | site-note | general",
  "priority": "one of: high | medium | low",
  "summary": "one crisp sentence",
  "detail": "clean prose version of the full note",
  "action_items": ["action 1", "action 2"]
}

Voice note: "${transcript}"`
      }]
    })
  });

  if (!res.ok) throw new Error(`Claude error: ${await res.text()}`);
  const text = (await res.json()).content[0].text.trim();
  return JSON.parse(text.replace(/```json\n?|\n?```/g, ''));
}

async function logToSheets(parsed, transcript) {
  const url = process.env.SHEETS_DIARY_WEBHOOK;
  if (!url) return null;

  const row = [
    parsed.date,
    parsed.time,
    parsed.location,
    parsed.category,
    parsed.priority,
    parsed.summary,
    parsed.detail,
    (parsed.action_items || []).join('; '),
    transcript
  ];

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ row })
  });

  return res.ok ? await res.json() : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { text, audioBase64, mimeType } = req.body || {};
    let transcript = text || await transcribeAudio(audioBase64, mimeType || 'audio/webm');
    if (!transcript) return res.status(400).json({ error: 'No audio or text provided' });

    const parsed = await parseWithClaude(transcript);
    const sheetsResult = await logToSheets(parsed, transcript);

    return res.status(200).json({
      ok: true,
      transcript,
      parsed,
      saved_to_sheets: !!sheetsResult
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
```

---

## Step 3: Create public/diary.html

This is the UI that lives on your phone's home screen:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Voice Diary</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0a; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 2rem 1rem; }
    h1 { font-size: 1.4rem; font-weight: 600; color: #fff; margin-bottom: 0.25rem; }
    .subtitle { font-size: 0.85rem; color: #666; margin-bottom: 2.5rem; }
    #micBtn { width: 140px; height: 140px; border-radius: 50%; border: none; background: #1a1a2e; color: #fff; font-size: 3rem; cursor: pointer; transition: all 0.2s; box-shadow: 0 0 0 0 rgba(59,130,246,0.4); display: flex; align-items: center; justify-content: center; }
    #micBtn:hover { background: #16213e; }
    #micBtn.recording { background: #7f1d1d; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(239,68,68,0.4); } 70% { box-shadow: 0 0 0 20px rgba(239,68,68,0); } 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); } }
    #status { margin-top: 1.5rem; font-size: 0.9rem; color: #888; min-height: 1.5rem; }
    #result { margin-top: 2rem; width: 100%; max-width: 500px; background: #111; border-radius: 12px; padding: 1.25rem; display: none; }
    .field { margin-bottom: 0.75rem; }
    .label { font-size: 0.7rem; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
    .value { font-size: 0.9rem; color: #ddd; margin-top: 0.2rem; }
    .badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 99px; font-size: 0.75rem; font-weight: 600; }
    .high { background: #7f1d1d; color: #fca5a5; }
    .medium { background: #78350f; color: #fcd34d; }
    .low { background: #14532d; color: #86efac; }
    .saved { color: #4ade80; font-size: 0.8rem; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <h1>Voice Diary</h1>
  <p class="subtitle">Tap to record · speaks to spreadsheet</p>
  <button id="micBtn">🎙️</button>
  <div id="status">Ready</div>
  <div id="result"></div>

  <script>
    const btn = document.getElementById('micBtn');
    const status = document.getElementById('status');
    const result = document.getElementById('result');
    let mediaRecorder, chunks = [], recording = false;

    btn.addEventListener('click', async () => {
      if (recording) {
        mediaRecorder.stop();
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        chunks = [];
        mediaRecorder.ondataavailable = e => chunks.push(e.data);
        mediaRecorder.onstop = async () => {
          btn.classList.remove('recording');
          btn.textContent = '🎙️';
          recording = false;
          status.textContent = 'Transcribing...';
          result.style.display = 'none';
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const reader = new FileReader();
          reader.onload = async () => {
            const base64 = reader.result.split(',')[1];
            try {
              const res = await fetch('/api/diary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audioBase64: base64, mimeType: 'audio/webm' })
              });
              const data = await res.json();
              if (!data.ok) throw new Error(data.error);
              showResult(data);
              status.textContent = 'Done ✓';
            } catch (e) {
              status.textContent = 'Error: ' + e.message;
            }
          };
          reader.readAsDataURL(blob);
          stream.getTracks().forEach(t => t.stop());
        };
        mediaRecorder.start();
        recording = true;
        btn.classList.add('recording');
        btn.textContent = '⏹️';
        status.textContent = 'Recording... tap to stop';
      } catch (e) {
        status.textContent = 'Mic error: ' + e.message;
      }
    });

    function showResult(data) {
      const p = data.parsed;
      const pclass = p.priority === 'high' ? 'high' : p.priority === 'low' ? 'low' : 'medium';
      result.innerHTML = `
        <div class="field"><div class="label">Summary</div><div class="value">${p.summary}</div></div>
        <div class="field"><div class="label">Category / Priority</div><div class="value">${p.category} &nbsp; <span class="badge ${pclass}">${p.priority}</span></div></div>
        <div class="field"><div class="label">When / Where</div><div class="value">${p.date} ${p.time !== 'unspecified' ? '· ' + p.time : ''} ${p.location !== 'unspecified' ? '· ' + p.location : ''}</div></div>
        ${p.detail ? `<div class="field"><div class="label">Detail</div><div class="value">${p.detail}</div></div>` : ''}
        ${(p.action_items||[]).length ? `<div class="field"><div class="label">Action Items</div><div class="value">${p.action_items.map(a => '• ' + a).join('<br>')}</div></div>` : ''}
        ${data.saved_to_sheets ? '<div class="saved">✓ Saved to Google Sheets</div>' : ''}
      `;
      result.style.display = 'block';
    }
  </script>
</body>
</html>
```

---

## Step 4: Add Env Vars and Deploy

```bash
# Use printf, not echo — PowerShell echo adds \r line endings that corrupt the value
printf 'your-anthropic-api-key' | vercel env add ANTHROPIC_API_KEY production
printf 'your-openai-api-key' | vercel env add OPENAI_API_KEY production
printf 'https://script.google.com/macros/s/YOUR_ID/exec' | vercel env add SHEETS_DIARY_WEBHOOK production

vercel --prod
```

Your voice diary is live at: `https://your-project.vercel.app/diary.html`

---

## Step 5: Add to Your Phone's Home Screen

**iPhone (Safari):**
1. Open the URL in Safari
2. Tap the Share button (box with arrow) → **Add to Home Screen**
3. Name it "Voice Diary" → Add

**Android (Chrome):**
1. Open the URL in Chrome
2. Tap the 3-dot menu → **Add to Home screen**
3. Name it → Add

It will appear as an app icon. Opening it goes straight to the mic — no browser chrome, no address bar.

---

## What a Parsed Entry Looks Like

You say:
> "Talked to Dave on site this morning, there's a drainage issue on the north side of building C, need to get a plumber out there by Friday, high priority"

You get in your Sheet:
| Date | Time | Location | Category | Priority | Summary | Detail | Action Items | Transcript |
|------|------|----------|----------|----------|---------|--------|-------------|------------|
| 2026-06-28 | unspecified | Building C north side | site-note | high | Dave flagged drainage issue at north side of Building C | Spoke with Dave on site. Drainage problem on north side of Building C needs attention before end of week. | Get plumber scheduled by Friday | Talked to Dave on site... |

---

## Customizing the Categories

The categories in the system prompt (`business-idea | task | reflection | meeting | site-note | general`) are just strings Claude fills in. Edit the prompt inside `api/diary.js` to match your workflow — use whatever categories make sense for your sheets.

---

## Troubleshooting

**"Mic error: Permission denied"** — First time use, the browser asks for microphone permission. Tap Allow. If you previously denied it, reset permissions in your phone's Settings → Site Permissions.

**"Whisper error: 401"** — Your `OPENAI_API_KEY` is wrong or not deployed. Run `vercel env ls` and `vercel --prod` to redeploy with the correct key.

**Sheet not updating** — The Google Apps Script must be deployed as a Web App with access set to "Anyone." If you change the script code, you must create a **New deployment** (not update existing) to get a fresh URL.

**JSON parse error from Claude** — Rarely, Haiku returns a code block with triple backticks. The replace in `parseWithClaude` handles this, but if it fails, check the raw response and adjust the regex.

---

## You Now Own This

Your voice notes live in YOUR Google Sheet. Your Vercel deployment is free. Your API calls are pennies. No subscription. No vendor lock-in. No "AI journaling app" that sells your thoughts.

This is the voice layer for your life, wired directly to the spreadsheet you already use.
