// test/stt.test.mjs — Whisper Bite 1: the on-device speech-to-text
// engine module (public/stt.js + public/stt-worker.js), shipped behind
// a flag with NO wiring into the app's pages.
//
// Two layers, matching the house style (cf. alarms.test.mjs):
//   1. Pure-logic + engine tests over public/stt.js: config resolution,
//      the LANGUAGE LAW (the options that reach the worker always carry
//      task 'transcribe' + a concrete pinned language — the Bite 0
//      spike proved an unpinned call silently translates Spanish),
//      platform fallback decisions, the download state machine driven
//      by a fake port (progress, cancel/resume, load failure + retry,
//      transcribe failure), and the flag/language settings.
//   2. Static contract checks: the worker installs its message handler
//      before any dynamic import, loads the bundled (non-.web)
//      Transformers build, sets the ONNX wasm paths explicitly, uses
//      the Cache API; the flag defaults OFF; and no shipped page
//      references the module (Bites 2/4 do the wiring, not this bite).
//
// NOT covered here (nothing in this environment can cover it): a real
// Whisper model transcribing on a real phone. The fake port plays the
// worker's protocol; real-device behaviour stays UNVERIFIED.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  STT_FLAG_KEY,
  STT_LANGUAGE_KEY,
  DEFAULT_STT_CONFIG,
  whisperLanguageName,
  whisperLanguageCode,
  resolveTranscribeLanguage,
  buildTranscribeOptions,
  validateTranscribeOptions,
  modelSpecFor,
  resolveSttConfig,
  workerConfigFor,
  isSttEnabled,
  setSttEnabled,
  storedSttLanguage,
  setSttLanguage,
  platformSupport,
  aggregateProgress,
  createSttEngine,
  makeFakePort,
  runSttSelfTest,
} from '../public/stt.js';

const sttJs = readFileSync(new URL('../public/stt.js', import.meta.url), 'utf8');
const workerJs = readFileSync(new URL('../public/stt-worker.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const onboardingJs = readFileSync(new URL('../public/onboarding.js', import.meta.url), 'utf8');
const diaryHtml = readFileSync(new URL('../public/diary.html', import.meta.url), 'utf8');
const rootDiaryHtml = readFileSync(new URL('../diary.html', import.meta.url), 'utf8');

const memoryStorage = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
};
const PLATFORM_OK = { Worker: function () {}, WebAssembly: {}, caches: {} };
const engineWith = (over = {}) => createSttEngine({
  storage: memoryStorage(),
  platform: PLATFORM_OK,
  config: { enabled: true },
  createPort: () => makeFakePort(),
  ...over,
});

// ─── Config resolution ──────────────────────────────────────────────────

test('resolveSttConfig defaults: base model, q8, wasm, flag off (scope recommendation)', () => {
  const cfg = resolveSttConfig();
  assert.equal(cfg.model, 'base');
  assert.equal(cfg.modelId, 'onnx-community/whisper-base');
  assert.equal(cfg.dtype, 'q8');
  assert.equal(cfg.device, 'wasm');
  assert.equal(cfg.enabled, false);
  assert.equal(DEFAULT_STT_CONFIG.enabled, false); // the flag ships OFF
  assert.equal(cfg.modelFallback, false);
});

test('model is selectable by config (tiny/base/small, q8 default dtype)', () => {
  assert.equal(resolveSttConfig({ model: 'tiny' }).modelId, 'onnx-community/whisper-tiny');
  assert.equal(resolveSttConfig({ model: 'small' }).modelId, 'onnx-community/whisper-small');
  assert.equal(resolveSttConfig({ model: 'small', dtype: 'q4' }).dtype, 'q4');
  const unknown = resolveSttConfig({ model: 'huge' });
  assert.equal(unknown.model, 'base');            // unknown name cannot reach the worker
  assert.equal(unknown.modelFallback, true);
  assert.equal(modelSpecFor('tiny').fallback, false);
});

test('library URL names the bundled (non-.web) build; wasm paths are explicit', () => {
  const cfg = resolveSttConfig();
  assert.ok(cfg.libraryUrl.endsWith('/transformers.min.js'), cfg.libraryUrl);
  assert.ok(!cfg.libraryUrl.includes('.web.'), cfg.libraryUrl);
  assert.equal(cfg.wasmPaths, cfg.assetBase);
  const custom = resolveSttConfig({ assetBase: '/vendor/stt' });
  assert.equal(custom.libraryUrl, '/vendor/stt/transformers.min.js'); // slash normalized
  assert.equal(custom.wasmPaths, '/vendor/stt/');
});

test('workerConfigFor carries exactly what the worker needs', () => {
  const wc = workerConfigFor(resolveSttConfig({ model: 'tiny' }));
  assert.deepEqual(Object.keys(wc).sort(),
    ['device', 'dtype', 'libraryUrl', 'modelId', 'remoteHost', 'useBrowserCache', 'wasmPaths']);
  assert.equal(wc.modelId, 'onnx-community/whisper-tiny');
  assert.equal(wc.useBrowserCache, true); // Cache API storage on
  assert.equal(workerConfigFor(resolveSttConfig({ cacheModel: false })).useBrowserCache, false);
});

// ─── THE LANGUAGE LAW ───────────────────────────────────────────────────

test('whisperLanguageName maps the app languages to Whisper names', () => {
  assert.equal(whisperLanguageName('en'), 'english');
  assert.equal(whisperLanguageName('es'), 'spanish');
  assert.equal(whisperLanguageName('ES'), 'spanish');
  assert.equal(whisperLanguageName(' spanish '), 'spanish');
  assert.equal(whisperLanguageName('auto'), null);
  assert.equal(whisperLanguageName('fr'), null); // v1 pins only the app languages
  assert.equal(whisperLanguageName(undefined), null);
  assert.equal(whisperLanguageCode('english'), 'en');
  assert.equal(whisperLanguageCode('spanish'), 'es');
});

test('resolveTranscribeLanguage: explicit > app > default; auto never survives', () => {
  assert.deepEqual(resolveTranscribeLanguage({ language: 'es', appLanguage: 'en' }),
    { code: 'es', name: 'spanish', source: 'explicit' });
  assert.deepEqual(resolveTranscribeLanguage({ language: 'auto', appLanguage: 'es' }),
    { code: 'es', name: 'spanish', source: 'app' });
  assert.deepEqual(resolveTranscribeLanguage({}),
    { code: 'en', name: 'english', source: 'default' });
  assert.deepEqual(resolveTranscribeLanguage({ language: 'auto', appLanguage: 'auto' }),
    { code: 'en', name: 'english', source: 'default' });
  // Unsupported explicit value falls DOWN the chain, never to the model.
  assert.deepEqual(resolveTranscribeLanguage({ language: 'fr', appLanguage: 'es' }),
    { code: 'es', name: 'spanish', source: 'fallback' });
});

test('buildTranscribeOptions always pins task transcribe + a concrete language', () => {
  for (const input of [{}, { language: 'auto' }, { language: 'es' }, { appLanguage: 'es' }, { language: 'auto', appLanguage: 'auto' }]) {
    const opts = buildTranscribeOptions(input);
    assert.equal(opts.task, 'transcribe');
    assert.ok(opts.language === 'english' || opts.language === 'spanish', JSON.stringify(input));
    assert.equal(validateTranscribeOptions(opts).ok, true);
  }
  assert.equal(buildTranscribeOptions({ language: 'es' }).language, 'spanish');
  assert.equal(buildTranscribeOptions({ language: 'es' }).chunk_length_s, 30);
});

test('validateTranscribeOptions refuses translate / unpinned / auto (the spike failure shapes)', () => {
  assert.equal(validateTranscribeOptions({ task: 'translate', language: 'spanish' }).ok, false);
  assert.equal(validateTranscribeOptions({ task: 'transcribe' }).ok, false);
  assert.equal(validateTranscribeOptions({ task: 'transcribe', language: 'auto' }).ok, false);
  assert.equal(validateTranscribeOptions({ task: 'transcribe', language: null }).ok, false);
  assert.equal(validateTranscribeOptions(null).ok, false);
  assert.equal(validateTranscribeOptions({ task: 'transcribe', language: 'english' }).ok, true);
});

// ─── Platform fallback decisions ────────────────────────────────────────

test('platformSupport: Worker and WebAssembly are hard requirements, Cache API is a note', () => {
  assert.deepEqual(platformSupport(PLATFORM_OK), { supported: true, reasons: [], notes: [] });
  const noWorker = platformSupport({ Worker: undefined, WebAssembly: {}, caches: {} });
  assert.equal(noWorker.supported, false);
  assert.ok(noWorker.reasons.includes('worker_unavailable'));
  const noWasm = platformSupport({ Worker: function () {}, WebAssembly: undefined, caches: {} });
  assert.equal(noWasm.supported, false);
  assert.ok(noWasm.reasons.includes('webassembly_unavailable'));
  const noCache = platformSupport({ Worker: function () {}, WebAssembly: {}, caches: undefined });
  assert.equal(noCache.supported, true); // works, but the model re-downloads per session
  assert.ok(noCache.notes.includes('cache_api_unavailable'));
});

// ─── Progress aggregation ───────────────────────────────────────────────

test('aggregateProgress sums files; fraction stays null while any total is unknown', () => {
  const snap = aggregateProgress([
    { file: 'a.onnx', loaded: 50, total: 100, status: 'progress' },
    { file: 'b.onnx', loaded: 25, total: 50, status: 'progress' },
    { file: 'a.onnx', loaded: 100, total: 100, status: 'done' },
  ]);
  assert.equal(snap.loaded, 125);
  assert.equal(snap.total, 150);
  assert.equal(snap.fraction, 125 / 150);
  const unknown = aggregateProgress([{ file: 'a.onnx', loaded: 10, total: 0 }]);
  assert.equal(unknown.fraction, null); // no made-up percentages
  assert.equal(aggregateProgress([]).fraction, null);
});

// ─── Flag + language settings ────────────────────────────────────────────

test('flag and language settings persist in storage, off by default', () => {
  const storage = memoryStorage();
  const cfg = resolveSttConfig({}, storage);
  assert.equal(isSttEnabled(cfg, storage), false);
  assert.equal(setSttEnabled(true, cfg, storage), true);
  assert.equal(storage.getItem(STT_FLAG_KEY), '1');
  assert.equal(setSttEnabled(false, cfg, storage), false);
  assert.equal(storedSttLanguage(cfg, storage), null);
  assert.equal(setSttLanguage('es', cfg, storage), 'es');
  assert.equal(storedSttLanguage(cfg, storage), 'es');
  assert.equal(storage.getItem(STT_LANGUAGE_KEY), 'es');
  assert.equal(setSttLanguage('klingon', cfg, storage), null); // unrepresentable pin is refused
});

// ─── Engine: gating + fallback reporting ────────────────────────────────

test('engine with the flag off reports disabled and never creates a worker', async () => {
  let ports = 0;
  const engine = createSttEngine({
    storage: memoryStorage(), platform: PLATFORM_OK,
    createPort: () => { ports++; return makeFakePort(); },
  });
  assert.deepEqual(await engine.ensureModel(), { available: false, reason: 'disabled' });
  assert.deepEqual(await engine.transcribe(new Float32Array(16)), { available: false, reason: 'disabled' });
  assert.equal(ports, 0);
  assert.equal(engine.status().state, 'idle');
});

test('engine on an unsupported platform reports unsupported with reasons', async () => {
  const engine = engineWith({ platform: { Worker: undefined, WebAssembly: undefined, caches: {} } });
  const res = await engine.ensureModel();
  assert.equal(res.available, false);
  assert.equal(res.reason, 'unsupported');
  assert.ok(res.reasons.includes('worker_unavailable'));
  assert.ok(res.reasons.includes('webassembly_unavailable'));
});

test('engine can be enabled through the storage flag alone', async () => {
  const storage = memoryStorage();
  storage.setItem(STT_FLAG_KEY, '1');
  const engine = createSttEngine({ storage, platform: PLATFORM_OK, createPort: () => makeFakePort() });
  assert.equal(engine.status().enabled, true);
  assert.equal((await engine.ensureModel()).available, true);
});

// ─── Engine: the download state machine ─────────────────────────────────

test('ensureModel downloads with aggregated progress and lands ready', async () => {
  const port = makeFakePort({
    totalBytes: 999,
    progressEvents: [
      { file: 'encoder.onnx', loaded: 40, total: 100, status: 'progress' },
      { file: 'decoder.onnx', loaded: 50, total: 100, status: 'progress' },
      { file: 'encoder.onnx', loaded: 100, total: 100, status: 'done' },
      { file: 'decoder.onnx', loaded: 100, total: 100, status: 'done' },
    ],
  });
  const engine = engineWith({ createPort: () => port });
  const seen = [];
  const res = await engine.ensureModel({ onProgress: (s) => seen.push(s) });
  assert.equal(res.available, true);
  assert.equal(res.totalBytes, 999);
  assert.equal(engine.isReady(), true);
  assert.equal(engine.status().state, 'ready');
  const last = seen[seen.length - 1];
  assert.equal(last.loaded, 200);
  assert.equal(last.fraction, 1);
  // A second ensureModel is a no-op, not a re-download.
  assert.equal((await engine.ensureModel()).alreadyReady, true);
  assert.equal(port.sent.filter((m) => m.type === 'load').length, 1);
});

test('cancelDownload terminates the worker; ensureModel resumes on a fresh one', async () => {
  const ports = [];
  const engine = engineWith({
    createPort: () => {
      const p = ports.length === 0 ? makeFakePort({ hangLoad: true }) : makeFakePort({ totalBytes: 5 });
      ports.push(p);
      return p;
    },
  });
  const first = engine.ensureModel();       // hangs: the fake never completes
  assert.equal(engine.status().state, 'downloading');
  const cancel = engine.cancelDownload();
  assert.equal(cancel.cancelled, true);
  assert.equal(ports[0].terminated, true);
  assert.equal(engine.status().state, 'idle');
  assert.deepEqual(await first, { available: false, reason: 'cancelled' });
  // Resume: a fresh worker, cached files make the load complete.
  const second = await engine.ensureModel();
  assert.equal(second.available, true);
  assert.equal(ports.length, 2);
  assert.equal(engine.isReady(), true);
  // Cancel outside a download is a no-op.
  assert.equal(engine.cancelDownload().cancelled, false);
});

test('a worker error during load reports load_failed; a retry starts fresh and succeeds', async () => {
  const ports = [];
  const engine = engineWith({
    createPort: () => {
      const p = ports.length === 0 ? makeFakePort({ loadError: 'network_gone' }) : makeFakePort();
      ports.push(p);
      return p;
    },
  });
  const fail = await engine.ensureModel();
  assert.equal(fail.available, false);
  assert.equal(fail.reason, 'load_failed');
  assert.equal(fail.error, 'network_gone');
  assert.equal(engine.status().state, 'error');
  assert.equal(ports[0].terminated, true); // failed worker is dropped, not reused
  assert.equal((await engine.ensureModel()).available, true);
  assert.equal(ports.length, 2);
});

// ─── Engine: transcription + the language law at the worker boundary ────

test('transcribe pins the app language: spanish reaches the model call', async () => {
  const port = makeFakePort({ text: 'buenos días' });
  const engine = engineWith({ createPort: () => port, getAppLanguage: () => 'es' });
  await engine.ensureModel();
  const res = await engine.transcribe(new Float32Array(1600));
  assert.equal(res.available, true);
  assert.equal(res.text, 'buenos días');
  assert.equal(res.language, 'es');
  // The exact options that crossed to the worker:
  assert.equal(port.lastTranscribeOptions.task, 'transcribe');
  assert.equal(port.lastTranscribeOptions.language, 'spanish');
});

test('per-call language beats the app setting; auto still lands pinned', async () => {
  const port = makeFakePort();
  const engine = engineWith({ createPort: () => port, getAppLanguage: () => 'es' });
  await engine.ensureModel();
  const en = await engine.transcribe(new Float32Array(160), { language: 'en' });
  assert.equal(en.language, 'en');
  assert.equal(port.lastTranscribeOptions.language, 'english');
  const auto = await engine.transcribe(new Float32Array(160), { language: 'auto' });
  assert.equal(auto.language, 'es'); // auto resolved to the app setting BEFORE the model
  assert.equal(port.lastTranscribeOptions.language, 'spanish');
  assert.equal(port.lastTranscribeOptions.task, 'transcribe');
});

test('transcribe before the model is ready reports model_not_ready', async () => {
  const engine = engineWith();
  const res = await engine.transcribe(new Float32Array(160));
  assert.equal(res.available, false);
  assert.equal(res.reason, 'model_not_ready');
});

test('a worker error during transcribe reports transcribe_failed and the engine stays ready', async () => {
  const script = {};
  const port = makeFakePort(script);
  const engine = engineWith({ createPort: () => port });
  await engine.ensureModel();
  script.transcribeError = 'decoder_oom';
  const fail = await engine.transcribe(new Float32Array(160));
  assert.equal(fail.available, false);
  assert.equal(fail.reason, 'transcribe_failed');
  assert.equal(engine.isReady(), true);
  script.transcribeError = undefined;
  assert.equal((await engine.transcribe(new Float32Array(160))).available, true);
});

test('the stored STT language setting is the default app-language source', async () => {
  const storage = memoryStorage();
  storage.setItem(STT_LANGUAGE_KEY, 'es');
  const port = makeFakePort();
  const engine = createSttEngine({
    storage, platform: PLATFORM_OK, config: { enabled: true }, createPort: () => port,
  });
  await engine.ensureModel();
  await engine.transcribe(new Float32Array(160));
  assert.equal(port.lastTranscribeOptions.language, 'spanish');
});

test('runSttSelfTest: the built-in contract check passes', async () => {
  const report = await runSttSelfTest();
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.checks.language_pinned_spanish, true);
});

// ─── Static contract checks: worker traps + the bite boundary ───────────

test('worker installs its message handler before any dynamic import (spike trap)', () => {
  const handlerAt = workerJs.indexOf('self.onmessage');
  const importAt = workerJs.indexOf('import(');
  assert.ok(handlerAt > -1 && importAt > -1);
  assert.ok(handlerAt < importAt, 'onmessage must be installed before the first dynamic import');
});

test('worker sets the ONNX wasm paths explicitly and uses the Cache API', () => {
  assert.ok(workerJs.includes('env.backends.onnx.wasm.wasmPaths'));
  assert.ok(workerJs.includes('useBrowserCache'));
  assert.ok(workerJs.includes('allowLocalModels = false'));
});

test('worker re-validates transcribe options (language law, defence in depth)', () => {
  assert.ok(workerJs.includes('validateTranscribeOptions'));
  assert.ok(workerJs.includes("task: 'transcribe'"));
});

test('module defaults name the bundled build from the pinned transformers version', () => {
  assert.ok(sttJs.includes('@huggingface/transformers@3.8.1'));
  assert.ok(sttJs.includes('transformers.min.js'));
  assert.ok(!sttJs.includes('transformers.web.min.js"') && !sttJs.includes("transformers.web.min.js'"));
});

test('BITE BOUNDARY: no shipped page wires the STT module in yet', () => {
  for (const [name, src] of [['index.html', indexHtml], ['onboarding.js', onboardingJs], ['public/diary.html', diaryHtml], ['diary.html', rootDiaryHtml]]) {
    assert.ok(!src.includes('stt.js') && !src.includes('stt-worker'), `${name} must not reference the STT module in Bite 1`);
  }
});
