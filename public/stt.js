// public/stt.js — ThinkinBuddy on-device speech-to-text (Whisper Bite 1).
//
// PLAIN ES module, no build step, same pattern as ./alarms.js and
// ./billing.js. NOTHING in the app imports this yet — Bite 1 ships the
// engine behind a flag (default OFF, see STT_FLAG_KEY). Diary/Actionable
// capture wiring is Bite 2 and the browser-voice swap is Bite 4; this
// module deliberately has no callers in the shipped pages, and
// test/stt.test.mjs pins that boundary.
//
// ─── What this is ───────────────────────────────────────────────────────
// A client-side speech-to-text engine: Transformers.js running a
// multilingual Whisper model (ONNX, q8) inside a Web Worker
// (./stt-worker.js). The phone turns speech into text; callers hand the
// server TEXT, exactly as if the user had typed it. Transcription costs
// nothing per minute and works with no signal, once the model is on the
// device. The buddy conversation is NOT this module's business — Mark's
// ears stay ElevenLabs (see the scoping report,
// docs/../whisper-on-device-scope §1a in the goal files).
//
// ─── The LANGUAGE LAW (from the Bite 0 spike — read before editing) ─────
// On the onnx-community Whisper exports, an unset/auto language does NOT
// mean "detect and transcribe". For Spanish input it silently TRANSLATES
// to English — even with task:'transcribe' set — and code-switched
// speech loses its Spanish half the same way (Bite 0 clips B and C:
// auto mode WER 1.00 on Spanish; pinned 'spanish' WER 0.10). So:
//
//   THE MODEL IS NEVER CALLED WITHOUT task:'transcribe' AND A CONCRETE
//   PINNED LANGUAGE. THERE IS NO AUTO PATH TO THE MODEL.
//
// Callers may pass language:'auto' to THIS module's API; it is resolved
// to a pinned language on the main thread, before any model call, in
// this order: explicit per-call language → the app language setting
// (STT_LANGUAGE_KEY / the engine's getAppLanguage dep — that setting IS
// the detection source) → 'en'. buildTranscribeOptions() is the single
// enforcement point, validateTranscribeOptions() re-checks the result
// (the worker checks again, defence in depth), and the tests pin that
// the exact options reaching the worker carry task 'transcribe' + the
// pinned language name. Whisper is only ever asked to transcribe the
// language the user is speaking — never to translate.
//
// Supported pinned languages in v1 are the app's languages: en, es.
// An unknown/unsupported language request falls back to the app
// language rather than risking an unmapped token at the model.
//
// ─── Model download: progress, cancel, resume ───────────────────────────
// ensureModel() downloads the model files once; Transformers.js stores
// them in the browser Cache API (env.useBrowserCache), so a completed
// file is never fetched again in this cache lifetime. Progress is
// aggregated per file and reported as { loaded, total, fraction }
// (fraction is null while a file's total is unknown — some hosts omit
// Content-Length; do not fake a percentage).
//
// CANCEL: there is no abort handle inside a Transformers.js download,
// so cancelDownload() TERMINATES the worker. Nothing is lost by doing
// so: files that finished downloading stay in the Cache API.
// RESUME: calling ensureModel() again starts a fresh worker and the
// load re-enters; already-cached files complete instantly from cache
// and progress jumps past them. "Resume" means exactly that — it is
// not a byte-offset resume inside a half-fetched file.
//
// ─── Runtime assets (the Bite 0 integration traps, handled) ─────────────
// The worker loads the library from config.libraryUrl, which defaults
// to the pinned jsDelivr build of @huggingface/transformers@3.8.1 —
// transformers.min.js, the BUNDLED build. The .web build
// (transformers.web.min.js) imports the bare specifier
// 'onnxruntime-common' and dies silently inside a module worker; it
// must never be used here. The bundle otherwise hardcodes its ONNX
// Runtime wasm URL to a CDN, so the worker sets
// env.backends.onnx.wasm.wasmPaths EXPLICITLY (config.wasmPaths,
// default: the same directory as the library). assetBase must serve
// transformers.min.js AND the ORT wasm pair side by side (the layout
// the Bite 0 spike proved); to self-host, copy those files next to
// stt-worker.js and point config.assetBase at that directory.
//
// ─── Fallback honesty ───────────────────────────────────────────────────
// Every engine method resolves a result object; it never throws at the
// caller and never pretends. Not usable → { available: false, reason }
// with reason one of: 'disabled' (flag off), 'unsupported' (no Worker /
// no WebAssembly — reasons[] says which), 'model_not_ready',
// 'load_failed', 'transcribe_failed', 'cancelled'. A caller that gets
// available:false falls back to whatever it does today (cloud
// transcription for captures, Web Speech for browser voice) and labels
// it — that wiring is Bites 2/4, not this module.
//
// ─── UNVERIFIED (in those words) ────────────────────────────────────────
// Everything about real devices: WASM speed on a mid-range phone,
// WebGPU inside the Android WebView / WKWebView, WKWebView cache
// persistence under storage pressure, battery. Bite 0 measured the
// engine on a VM (base q8 ≈ real-time, English WER 0.00, pinned-Spanish
// WER 0.10 on synthetic clips). This module's tests exercise the
// contract through a FAKE worker; no real model runs in the suite.

export const STT_FLAG_KEY = 'tb_stt_enabled_v1';
export const STT_LANGUAGE_KEY = 'tb_stt_language_v1';

// Pinned library build (Bite 0 spike used exactly this version).
export const TRANSFORMERS_VERSION = '3.8.1';
export const DEFAULT_ASSET_BASE =
  `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/`;

// Model catalogue. Sizes: base q8 model files measured in Bite 0
// (79,664,191 bytes fetched); tiny/small are scope-report estimates
// (scope §2a), informational only — the UI must not quote them as exact.
export const STT_MODELS = {
  tiny: { modelId: 'onnx-community/whisper-tiny', approxBytes: 40_000_000 },
  base: { modelId: 'onnx-community/whisper-base', approxBytes: 79_664_191 },
  small: { modelId: 'onnx-community/whisper-small', approxBytes: 250_000_000 },
};

export const DEFAULT_STT_CONFIG = {
  enabled: false,          // the flag. Off until a later bite turns it on.
  model: 'base',           // scope recommendation: multilingual base.
  dtype: 'q8',
  device: 'wasm',          // spike-proven; WebGPU is a bonus, not the plan.
  language: 'en',          // last-resort pin when nothing else is set.
  assetBase: DEFAULT_ASSET_BASE,
  cacheModel: true,        // Transformers.js Cache API storage.
};

// The app's languages → the language NAMES the Whisper tokenizer takes
// (the spike pinned 'spanish'/'english' verbatim; names are the proven
// form, so codes are always mapped to names before the model call).
const LANGUAGE_NAMES = { en: 'english', es: 'spanish' };
const NAME_TO_CODE = { english: 'en', spanish: 'es' };

// ─── Pure logic (unit-tested in test/stt.test.mjs) ──────────────────────

/** 'en' | 'es' | 'english' | 'spanish' → the Whisper language name, else null. */
export function whisperLanguageName(input) {
  if (typeof input !== 'string') return null;
  const v = input.trim().toLowerCase();
  if (LANGUAGE_NAMES[v]) return LANGUAGE_NAMES[v];
  if (NAME_TO_CODE[v]) return v;
  return null;
}

/** Any accepted language input → its code ('en'/'es'), else null. */
export function whisperLanguageCode(input) {
  if (typeof input !== 'string') return null;
  const v = input.trim().toLowerCase();
  if (LANGUAGE_NAMES[v]) return v;
  if (NAME_TO_CODE[v]) return NAME_TO_CODE[v];
  return null;
}

/**
 * Resolve the language a transcription WILL use. Returns
 * { code, name, source } where source is 'explicit' | 'app' | 'default'
 * | 'fallback' (an explicit/app value existed but was unsupported, so
 * the next source down won). 'auto' (or no value) at any level defers
 * to the next level down — it never survives into the result.
 */
export function resolveTranscribeLanguage({ language, appLanguage } = {}) {
  const isAuto = (v) => typeof v !== 'string' || v.trim().toLowerCase() === 'auto' || v.trim() === '';
  const levels = [
    ['explicit', language],
    ['app', appLanguage],
    ['default', DEFAULT_STT_CONFIG.language],
  ];
  let sawUnsupported = false;
  for (const [source, value] of levels) {
    if (isAuto(value)) continue;
    const code = whisperLanguageCode(value);
    if (code) {
      return { code, name: LANGUAGE_NAMES[code], source: sawUnsupported ? 'fallback' : source };
    }
    sawUnsupported = true;
  }
  // Unreachable while DEFAULT_STT_CONFIG.language stays supported; the
  // law says a concrete pin comes out of this function no matter what.
  return { code: 'en', name: 'english', source: 'fallback' };
}

/**
 * THE enforcement point of the language law: the only options object
 * this module ever hands to the worker/model. Always task:'transcribe'
 * (never 'translate'), always a concrete pinned language name.
 */
export function buildTranscribeOptions(input = {}) {
  const { code, name, source } = resolveTranscribeLanguage(input);
  return {
    task: 'transcribe',
    language: name,
    languageCode: code,
    languageSource: source,
    // Whisper is a batch model over 30 s windows; long captures chunk
    // with overlap (scope §4, hard part 3).
    chunk_length_s: 30,
    stride_length_s: 5,
  };
}

/**
 * Re-check an options object against the language law. The worker runs
 * this on every transcribe message (defence in depth): anything that
 * is not task:'transcribe' with a concrete, supported, pinned language
 * name is refused before the model sees it.
 */
export function validateTranscribeOptions(opts) {
  const reasons = [];
  if (!opts || typeof opts !== 'object') return { ok: false, reasons: ['options_missing'] };
  if (opts.task !== 'transcribe') reasons.push('task_not_transcribe');
  if (typeof opts.language !== 'string' || !NAME_TO_CODE[opts.language]) {
    reasons.push('language_not_pinned');
  }
  return { ok: reasons.length === 0, reasons };
}

/** Model spec for a config model name; unknown names fall back to base. */
export function modelSpecFor(model) {
  if (typeof model === 'string' && STT_MODELS[model]) {
    return { name: model, ...STT_MODELS[model], fallback: false };
  }
  return { name: 'base', ...STT_MODELS.base, fallback: true };
}

/**
 * Normalize a user config into the full runtime config the worker gets.
 * libraryUrl always names the bundled (non-.web) build; wasmPaths
 * always points at the directory that serves the ORT wasm files.
 */
export function resolveSttConfig(overrides = {}, storage) {
  const spec = modelSpecFor(overrides.model ?? DEFAULT_STT_CONFIG.model);
  const assetBase = overrides.assetBase || DEFAULT_STT_CONFIG.assetBase;
  const base = assetBase.endsWith('/') ? assetBase : `${assetBase}/`;
  return {
    enabled: overrides.enabled ?? DEFAULT_STT_CONFIG.enabled,
    model: spec.name,
    modelFallback: spec.fallback,
    modelId: spec.modelId,
    approxBytes: spec.approxBytes,
    dtype: overrides.dtype || DEFAULT_STT_CONFIG.dtype,
    device: overrides.device || DEFAULT_STT_CONFIG.device,
    language: overrides.language || DEFAULT_STT_CONFIG.language,
    assetBase: base,
    libraryUrl: overrides.libraryUrl || `${base}transformers.min.js`,
    wasmPaths: overrides.wasmPaths || base,
    remoteHost: overrides.remoteHost || 'https://huggingface.co',
    cacheModel: overrides.cacheModel ?? DEFAULT_STT_CONFIG.cacheModel,
    flagKey: overrides.flagKey || STT_FLAG_KEY,
    languageKey: overrides.languageKey || STT_LANGUAGE_KEY,
    _storage: storage, // internal: flag/language reads (not sent to the worker)
  };
}

/** The worker-facing slice of the config (no storage, no functions). */
export function workerConfigFor(config) {
  return {
    modelId: config.modelId,
    dtype: config.dtype,
    device: config.device,
    libraryUrl: config.libraryUrl,
    wasmPaths: config.wasmPaths,
    remoteHost: config.remoteHost,
    useBrowserCache: config.cacheModel !== false,
  };
}

// ─── Settings (flag + language), stored like the other app prefs ───────

function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

export function isSttEnabled(config = resolveSttConfig(), storage = defaultStorage()) {
  if (config.enabled) return true;
  try { return storage?.getItem(config.flagKey || STT_FLAG_KEY) === '1'; } catch { return false; }
}

export function setSttEnabled(on, config = resolveSttConfig(), storage = defaultStorage()) {
  try {
    if (on) storage?.setItem(config.flagKey || STT_FLAG_KEY, '1');
    else storage?.removeItem(config.flagKey || STT_FLAG_KEY);
  } catch { /* storage unavailable: flag simply does not persist */ }
  return isSttEnabled(config, storage);
}

/** The stored app language setting for STT ('en'/'es'), or null. */
export function storedSttLanguage(config = resolveSttConfig(), storage = defaultStorage()) {
  try {
    const code = whisperLanguageCode(storage?.getItem(config.languageKey || STT_LANGUAGE_KEY));
    return code;
  } catch { return null; }
}

export function setSttLanguage(code, config = resolveSttConfig(), storage = defaultStorage()) {
  const valid = whisperLanguageCode(code);
  try {
    if (valid) storage?.setItem(config.languageKey || STT_LANGUAGE_KEY, valid);
    else storage?.removeItem(config.languageKey || STT_LANGUAGE_KEY);
  } catch { /* storage unavailable */ }
  return valid;
}

// ─── Platform support ────────────────────────────────────────────────────

/**
 * Can this environment run the engine at all? env is injectable for
 * tests: { Worker, WebAssembly, caches }. Worker + WebAssembly are
 * hard requirements (no worker → the UI thread would freeze; no wasm →
 * no ONNX runtime). The Cache API is a soft note: without it the model
 * re-downloads every session, but transcription still works.
 */
export function platformSupport(env = {}) {
  // A key PRESENT in env (even set to undefined) is the test's word on
  // that capability; only absent keys fall back to the real globals.
  const has = (k) => (k in env)
    ? !!env[k]
    : (typeof globalThis !== 'undefined' && !!globalThis[k]);
  const reasons = [];
  const notes = [];
  if (!has('Worker')) reasons.push('worker_unavailable');
  if (!has('WebAssembly')) reasons.push('webassembly_unavailable');
  if (!has('caches')) notes.push('cache_api_unavailable');
  return { supported: reasons.length === 0, reasons, notes };
}

// ─── Download progress aggregation ───────────────────────────────────────

/**
 * Aggregate per-file progress events ({ file, loaded, total, status })
 * into one { loaded, total, fraction, files } snapshot. fraction is
 * null until every reported file has a known total — a made-up
 * percentage would be a lie on hosts that omit Content-Length (the
 * spike hit exactly that).
 */
export function aggregateProgress(fileEvents) {
  const files = {};
  for (const ev of fileEvents || []) {
    if (!ev || typeof ev.file !== 'string') continue;
    files[ev.file] = {
      loaded: Math.max(files[ev.file]?.loaded || 0, ev.loaded || 0),
      total: ev.total || files[ev.file]?.total || 0,
      status: ev.status || 'progress',
    };
  }
  let loaded = 0;
  let total = 0;
  let allTotalsKnown = Object.keys(files).length > 0;
  for (const f of Object.values(files)) {
    loaded += f.loaded;
    total += f.total;
    if (!f.total) allTotalsKnown = false;
  }
  return {
    loaded,
    total,
    fraction: allTotalsKnown && total > 0 ? Math.min(1, loaded / total) : null,
    files,
  };
}

// ─── Audio decode (browser glue; tests pass Float32Array directly) ──────

async function decodeAudioBlob(blob) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  const OC = globalThis.OfflineAudioContext;
  if (!AC || !OC) throw new Error('audio_decode_unavailable');
  const raw = await blob.arrayBuffer();
  const ctx = new AC();
  let decoded;
  try { decoded = await ctx.decodeAudioData(raw); } finally { try { await ctx.close(); } catch { /* noop */ } }
  // Resample to Whisper's 16 kHz mono in one offline render (the
  // context downmixes to its single channel automatically).
  const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
  const off = new OC(1, frames, 16000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

// ─── Worker port (real Worker ↔ the tiny interface the engine uses) ─────

function defaultCreatePort() {
  if (typeof Worker === 'undefined') return null;
  const worker = new Worker(new URL('./stt-worker.js', import.meta.url), { type: 'module' });
  return {
    postMessage: (msg, transfer) => worker.postMessage(msg, transfer || []),
    addMessageListener: (fn) => worker.addEventListener('message', (e) => fn(e.data)),
    terminate: () => worker.terminate(),
  };
}

// ─── The engine ──────────────────────────────────────────────────────────
// deps (all injectable for tests):
//   config       — resolveSttConfig() output (or overrides for it)
//   storage      — localStorage-like { getItem, setItem, removeItem }
//   platform     — platformSupport() env override
//   createPort   — () => port { postMessage, addMessageListener,
//                  terminate } (defaults to a real module Worker over
//                  ./stt-worker.js; tests inject a fake)
//   getAppLanguage — () => 'en' | 'es' | null (the app language
//                  setting; defaults to the stored STT language)
//   decodeAudio  — (blob) => Promise<Float32Array> (defaults to the
//                  AudioContext decode above)

export function createSttEngine(deps = {}) {
  const storage = deps.storage !== undefined ? deps.storage : defaultStorage();
  const config = deps.config
    ? resolveSttConfig({ ...deps.config, enabled: deps.config.enabled }, storage)
    : resolveSttConfig({}, storage);
  const support = platformSupport(deps.platform || {});
  const createPort = deps.createPort || defaultCreatePort;
  const decodeAudio = deps.decodeAudio || decodeAudioBlob;
  const getAppLanguage = deps.getAppLanguage
    || (() => storedSttLanguage(config, storage) || config.language);

  let state = 'idle'; // idle | downloading | ready | transcribing | error
  let port = null;
  let nextId = 1;
  const pending = new Map(); // id -> { kind, resolve }
  let activeLoad = null;     // { id, onProgress, events: [] }

  function status() {
    return {
      available: state === 'ready' || state === 'transcribing',
      state,
      enabled: isSttEnabled(config, storage),
      supported: support.supported,
      supportReasons: support.reasons,
      model: config.model,
      modelId: config.modelId,
    };
  }

  function wirePort(p) {
    p.addMessageListener((msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'progress') {
        if (activeLoad && msg.id === activeLoad.id) {
          activeLoad.events.push(msg);
          try { activeLoad.onProgress?.(aggregateProgress(activeLoad.events)); } catch { /* listener errors never break the load */ }
        }
        return;
      }
      const entry = pending.get(msg.id);
      if (!entry) return;
      if (msg.type === 'error') {
        pending.delete(msg.id);
        entry.resolve({ ok: false, error: msg.message || 'worker_error' });
      } else if (msg.type === 'loaded' && entry.kind === 'load') {
        pending.delete(msg.id);
        entry.resolve({ ok: true, totalBytes: msg.totalBytes || 0 });
      } else if (msg.type === 'result' && entry.kind === 'transcribe') {
        pending.delete(msg.id);
        entry.resolve({ ok: true, text: msg.text || '', language: msg.language || null });
      }
    });
  }

  function ensurePort() {
    if (port) return port;
    port = createPort();
    if (port) wirePort(port);
    return port;
  }

  function dropPort() {
    if (port) { try { port.terminate(); } catch { /* already gone */ } port = null; }
    for (const [, entry] of pending) entry.resolve({ ok: false, error: 'worker_terminated' });
    pending.clear();
    activeLoad = null;
  }

  /**
   * Download (or confirm cached) + initialize the model.
   * opts.onProgress receives aggregateProgress() snapshots.
   * Resolves { available: true, totalBytes } or { available: false,
   * reason, ... } — never rejects.
   */
  async function ensureModel(opts = {}) {
    if (!isSttEnabled(config, storage)) return { available: false, reason: 'disabled' };
    if (!support.supported) return { available: false, reason: 'unsupported', reasons: support.reasons };
    if (state === 'ready') return { available: true, totalBytes: 0, alreadyReady: true };
    if (state === 'downloading' && activeLoad) return { available: false, reason: 'download_in_progress' };
    const p = ensurePort();
    if (!p) return { available: false, reason: 'unsupported', reasons: ['worker_unavailable'] };
    const id = nextId++;
    state = 'downloading';
    const token = { cancelled: false };
    activeLoad = { id, onProgress: opts.onProgress, events: [], token };
    const done = new Promise((resolve) => pending.set(id, { kind: 'load', resolve }));
    try {
      p.postMessage({ type: 'load', id, config: workerConfigFor(config) });
    } catch (e) {
      pending.delete(id);
      activeLoad = null;
      state = 'error';
      return { available: false, reason: 'load_failed', error: e?.message || String(e) };
    }
    const res = await done;
    if (activeLoad && activeLoad.id === id) activeLoad = null;
    if (token.cancelled) {
      // cancelDownload() already terminated the worker and reset the
      // state; report the cancellation, touch nothing else.
      return { available: false, reason: 'cancelled' };
    }
    if (!res.ok) {
      dropPort(); // a failed load leaves the worker in an unknown state; retry fresh
      state = 'error';
      return { available: false, reason: 'load_failed', error: res.error };
    }
    state = 'ready';
    return { available: true, totalBytes: res.totalBytes };
  }

  /**
   * Cancel an in-flight download by terminating the worker (see the
   * header: completed files survive in the Cache API, so a later
   * ensureModel() resumes past them). No-op when not downloading.
   */
  function cancelDownload() {
    if (state !== 'downloading') return { cancelled: false, state };
    if (activeLoad?.token) activeLoad.token.cancelled = true;
    dropPort();
    state = 'idle';
    return { cancelled: true, state };
  }

  /**
   * Transcribe audio → { available: true, text, language } where
   * language is the pinned code actually used. audio may be a
   * Float32Array of 16 kHz mono samples, an ArrayBuffer of the same,
   * or a Blob (decoded via deps.decodeAudio / AudioContext).
   * opts.language may be a code/name or 'auto' — see the LANGUAGE LAW.
   */
  async function transcribe(audio, opts = {}) {
    if (!isSttEnabled(config, storage)) return { available: false, reason: 'disabled' };
    if (!support.supported) return { available: false, reason: 'unsupported', reasons: support.reasons };
    if (state !== 'ready') return { available: false, reason: 'model_not_ready', state };
    let samples;
    try {
      if (audio instanceof Float32Array) samples = audio;
      else if (audio instanceof ArrayBuffer) samples = new Float32Array(audio);
      else if (typeof Blob !== 'undefined' && audio instanceof Blob) samples = await decodeAudio(audio);
      else return { available: false, reason: 'unsupported_audio_input' };
    } catch (e) {
      return { available: false, reason: 'audio_decode_failed', error: e?.message || String(e) };
    }
    const options = buildTranscribeOptions({
      language: opts.language,
      appLanguage: opts.appLanguage !== undefined ? opts.appLanguage : getAppLanguage(),
    });
    const check = validateTranscribeOptions(options);
    if (!check.ok) { // cannot happen while buildTranscribeOptions stands; the law fails closed anyway
      return { available: false, reason: 'language_pin_failed', reasons: check.reasons };
    }
    const id = nextId++;
    state = 'transcribing';
    const done = new Promise((resolve) => pending.set(id, { kind: 'transcribe', resolve }));
    // Copy the samples: the buffer is transferred to the worker.
    const copy = new Float32Array(samples);
    try {
      port.postMessage({ type: 'transcribe', id, audio: copy.buffer, options }, [copy.buffer]);
    } catch (e) {
      pending.delete(id);
      state = 'ready';
      return { available: false, reason: 'transcribe_failed', error: e?.message || String(e) };
    }
    const res = await done;
    state = 'ready';
    if (!res.ok) return { available: false, reason: 'transcribe_failed', error: res.error };
    return { available: true, text: res.text, language: options.languageCode, languageName: options.language };
  }

  /** Terminate the worker and forget the model (cache is kept). */
  function dispose() {
    dropPort();
    state = 'idle';
    return { available: false, reason: 'disposed' };
  }

  return {
    config,
    status,
    isReady: () => state === 'ready',
    ensureModel,
    cancelDownload,
    transcribe,
    dispose,
  };
}

// ─── Dev/self-test hook ──────────────────────────────────────────────────
// The codebase has no existing self-test page; this export is the hook:
// it drives the real engine against an in-memory fake port (no worker,
// no model) and reports whether the contract holds — flag gating,
// download state machine, language pinning. Callable from a console or
// a future dev page; imported by nothing in the shipped app.

export function makeFakePort(script = {}) {
  const listeners = new Set();
  const port = {
    sent: [],
    terminated: false,
    postMessage(msg) {
      port.sent.push(msg);
      const emit = (m) => queueMicrotask(() => { for (const fn of listeners) fn(m); });
      if (msg.type === 'load') {
        if (script.loadError) { emit({ type: 'error', id: msg.id, message: script.loadError }); return; }
        if (script.hangLoad) return; // never completes: the cancel path
        for (const ev of script.progressEvents || []) emit({ type: 'progress', id: msg.id, ...ev });
        emit({ type: 'loaded', id: msg.id, totalBytes: script.totalBytes || 0 });
      } else if (msg.type === 'transcribe') {
        if (script.transcribeError) { emit({ type: 'error', id: msg.id, message: script.transcribeError }); return; }
        port.lastTranscribeOptions = msg.options;
        emit({ type: 'result', id: msg.id, text: script.text ?? 'fake transcript', language: msg.options?.language || null });
      }
    },
    addMessageListener(fn) { listeners.add(fn); },
    terminate() { port.terminated = true; },
  };
  return port;
}

export async function runSttSelfTest() {
  const checks = [];
  const memoryStorage = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  };
  const platform = { Worker: function () {}, WebAssembly: {}, caches: {} };

  const off = createSttEngine({ storage: memoryStorage(), platform, createPort: () => makeFakePort() });
  checks.push(['flag_off_by_default', (await off.ensureModel()).reason === 'disabled']);

  const port = makeFakePort({ totalBytes: 1234, text: 'hola mundo' });
  const on = createSttEngine({
    storage: memoryStorage(), platform,
    config: { enabled: true },
    getAppLanguage: () => 'es',
    createPort: () => port,
  });
  const load = await on.ensureModel();
  checks.push(['model_loads', load.available === true && on.isReady()]);
  const tr = await on.transcribe(new Float32Array(1600));
  checks.push(['transcribe_returns_text', tr.available === true && tr.text === 'hola mundo']);
  checks.push(['language_pinned_spanish',
    port.lastTranscribeOptions?.task === 'transcribe' && port.lastTranscribeOptions?.language === 'spanish']);
  return { ok: checks.every(([, v]) => v), checks: Object.fromEntries(checks) };
}
