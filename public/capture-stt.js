// public/capture-stt.js — Whisper Bite 2: captures feed the on-device
// engine (public/stt.js). This module is the ONE switch every capture
// client routes its recorded audio through before posting:
//
//   flag ON + engine available → transcribe ON THE PHONE, post { text }
//   anything else              → post the audio exactly as captures do
//                                today (cloud transcription), with the
//                                fallback LABELLED — in the returned
//                                label, in a console.warn under the
//                                [capture-stt] tag, and (by the caller)
//                                in the page status line.
//
// The server contract is unchanged and this module depends on it: the
// Diary and Actionable handlers already prefer { text } and only call
// cloud transcription when text is absent (pinned by
// test/capture-stt.test.mjs). Posting text also removes the server's
// hard-coded English lock on cloud Whisper — the phone transcribes in
// the pinned app language (see the LANGUAGE LAW in stt.js: the engine
// is never called unpinned; 'auto' resolves explicit → app language →
// 'en' inside buildTranscribeOptions, and Spanish stays Spanish).
//
// Callers in this bite: the Diary page (public/diary.html + the root
// diary.html duplicate). The Actionable capture post uses the same
// buildCapturePost() to construct its payload — { text } when the
// engine heard it, { audioBase64, mimeType } when it did not.
//
// This module never throws at its caller and never claims "on-device"
// for a cloud result: via is 'on_device' only when the engine actually
// returned the text.

import {
  createSttEngine,
  isSttEnabled,
  resolveSttConfig,
  storedSttLanguage,
} from './stt.js';

export const CAPTURE_STT_TAG = '[capture-stt]';

/** Human label for a cloud fallback — shown in the UI, never silent. */
export function cloudFallbackLabel(reason) {
  return `On-device transcription unavailable (${reason}) — using cloud transcription`;
}

function defaultLog(...args) {
  try { console.warn(...args); } catch { /* logging never breaks a capture */ }
}

/**
 * Decide + (when possible) perform the on-device transcription of one
 * recorded capture.
 *
 * deps (all injectable for tests):
 *   engine       — a stt.js engine (defaults to one built per call)
 *   createEngine — factory for that engine
 *   config       — stt.js config overrides (flag/model/…)
 *   storage      — localStorage-like (flag + language reads)
 *   language     — explicit per-capture language ('en'/'es'/'auto')
 *   appLanguage  — the app language setting; defaults to the stored
 *                  STT language (STT_LANGUAGE_KEY), the same source the
 *                  engine itself would use
 *   onProgress   — model-download progress callback (first use)
 *   log          — fallback logger (defaults to console.warn)
 *
 * Resolves exactly one of:
 *   { mode: 'text',  text, language, languageName, via: 'on_device' }
 *   { mode: 'cloud', reason, label, via: 'cloud' }
 */
export async function transcribeCapture(audio, deps = {}) {
  const log = deps.log || defaultLog;
  const storage = deps.storage;
  const config = resolveSttConfig(deps.config || {}, storage);

  const cloud = (reason) => {
    const label = cloudFallbackLabel(reason);
    log(CAPTURE_STT_TAG, label);
    return { mode: 'cloud', reason, label, via: 'cloud' };
  };

  try {
    // Flag gate first: with the flag off we do not even build an
    // engine, let alone download a model — captures behave exactly as
    // they did before Bite 1 existed.
    if (!isSttEnabled(config, storage)) return cloud('stt_disabled');

    const engine = deps.engine
      || (deps.createEngine ? deps.createEngine() : createSttEngine({ config: deps.config || {}, storage }));

    const ready = await engine.ensureModel({ onProgress: deps.onProgress });
    if (!ready?.available) return cloud(ready?.reason || 'engine_unavailable');

    const appLanguage = deps.appLanguage !== undefined
      ? deps.appLanguage
      : storedSttLanguage(config, storage);
    const tr = await engine.transcribe(audio, {
      language: deps.language,
      appLanguage,
    });
    if (!tr?.available) return cloud(tr?.reason || 'transcribe_failed');
    if (!tr.text || !tr.text.trim()) return cloud('empty_transcript');

    return {
      mode: 'text',
      text: tr.text,
      language: tr.language || null,
      languageName: tr.languageName || null,
      via: 'on_device',
    };
  } catch (e) {
    return cloud(`capture_switch_error: ${e?.message || e}`);
  }
}

/**
 * Build the POST payload for a capture, whichever way the switch fell.
 *   on-device → { payload: { text }, via: 'on_device', language }
 *   cloud     → { payload: { audioBase64, mimeType }, via: 'cloud',
 *                 reason, label }
 * encodeAudio(blob) → Promise<base64 string> is supplied by the caller
 * (the Diary page's FileReader); it is only invoked on the cloud path.
 */
export async function buildCapturePost(audio, { mimeType, encodeAudio, ...deps } = {}) {
  const r = await transcribeCapture(audio, deps);
  if (r.mode === 'text') {
    return { payload: { text: r.text }, via: 'on_device', language: r.language, languageName: r.languageName };
  }
  const audioBase64 = await encodeAudio(audio);
  return { payload: { audioBase64, mimeType }, via: 'cloud', reason: r.reason, label: r.label };
}
