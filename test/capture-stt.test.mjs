// test/capture-stt.test.mjs — Whisper Bite 2: captures feed the
// on-device engine (public/capture-stt.js in front of public/stt.js).
//
// Three layers:
//   1. The capture switch, with fake engines: flag OFF → cloud payload
//      (engine never even built); flag ON + engine ok → { text } post
//      carrying the engine's text, with the app language passed through
//      the engine's pinning; flag ON + engine unavailable OR
//      transcription failed → cloud payload, LABELLED with the reason
//      (returned label + a [capture-stt] log line). No silent switches.
//   2. Handler pins: a { text } post to the Diary and Actionable
//      handlers NEVER calls the cloud transcribe function. Diary runs
//      in-process with a stubbed fetch (the safety.test.mjs pattern);
//      Actionable runs in a child process with module mocks (its DB
//      layer cannot load in the suite) — see
//      test/fixtures/actionable-handler-child.mjs. Both have an audio
//      CONTROL post proving the pin is not vacuous: audio still
//      transcribes in the cloud, exactly once.
//   3. Static wiring pins: both Diary pages route recordings through
//      capture-stt, keep the labelled cloud path, and do not claim
//      on-device anywhere else.
//
// NOT covered: a real Whisper model hearing a real voice on a real
// phone (the engine's own tests use a fake worker for the same
// reason). Real-device behaviour stays UNVERIFIED.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CAPTURE_STT_TAG,
  cloudFallbackLabel,
  transcribeCapture,
  buildCapturePost,
} from '../public/capture-stt.js';
import { STT_FLAG_KEY, STT_LANGUAGE_KEY, setSttEnabled } from '../public/stt.js';
import diaryHandler from '../server/handlers/diary.js';

const memoryStorage = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
};

const fakeEngine = ({ ensure, transcribe } = {}) => {
  const eng = {
    transcribeOpts: null,
    ensureModel: async () => ensure ?? { available: true, totalBytes: 0 },
    transcribe: async (audio, opts) => {
      eng.transcribeOpts = opts;
      return transcribe ?? { available: true, text: 'hola mundo', language: 'es', languageName: 'spanish' };
    },
  };
  return eng;
};

const logCapture = () => {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')) };
};

const ENCODE = async () => 'BASE64AUDIO';

// ─── 1. The capture switch ──────────────────────────────────────────────

test('switch: flag OFF → cloud payload, engine never built, fallback labelled', async () => {
  const { lines, log } = logCapture();
  let engineBuilt = false;
  const post = await buildCapturePost(new Blob(['x']), {
    mimeType: 'audio/webm',
    encodeAudio: ENCODE,
    storage: memoryStorage(),
    log,
    createEngine: () => { engineBuilt = true; return fakeEngine(); },
  });
  assert.equal(engineBuilt, false);
  assert.equal(post.via, 'cloud');
  assert.equal(post.reason, 'stt_disabled');
  assert.deepEqual(post.payload, { audioBase64: 'BASE64AUDIO', mimeType: 'audio/webm' });
  assert.ok(post.label.includes('cloud transcription'));
  assert.ok(lines.some((l) => l.includes(CAPTURE_STT_TAG) && l.includes('stt_disabled')));
});

test('switch: flag ON + engine ok → { text } post, no audio encoded, app language passed through', async () => {
  const storage = memoryStorage();
  setSttEnabled(true, {}, storage);
  storage.setItem(STT_LANGUAGE_KEY, 'es');
  const eng = fakeEngine();
  let encoded = false;
  const post = await buildCapturePost(new Blob(['x']), {
    mimeType: 'audio/webm',
    encodeAudio: async () => { encoded = true; return 'SHOULD-NOT-BE-USED'; },
    storage,
    log: () => {},
    engine: eng,
  });
  assert.equal(encoded, false);
  assert.equal(post.via, 'on_device');
  assert.deepEqual(post.payload, { text: 'hola mundo' });
  assert.equal(post.language, 'es');
  // The app language setting ('es' in storage) is what reached the
  // engine call — the engine pins it from there (stt.js language law).
  assert.equal(eng.transcribeOpts.appLanguage, 'es');
});

test('switch: explicit per-capture language passes through ahead of the app setting', async () => {
  const storage = memoryStorage();
  setSttEnabled(true, {}, storage);
  storage.setItem(STT_LANGUAGE_KEY, 'en');
  const eng = fakeEngine();
  const r = await transcribeCapture(new Blob(['x']), { storage, log: () => {}, engine: eng, language: 'es' });
  assert.equal(r.mode, 'text');
  assert.equal(eng.transcribeOpts.language, 'es');
  assert.equal(eng.transcribeOpts.appLanguage, 'en');
});

test('switch: flag ON + engine unavailable → labelled cloud fallback with the engine reason', async () => {
  const storage = memoryStorage();
  setSttEnabled(true, {}, storage);
  const { lines, log } = logCapture();
  const eng = fakeEngine({ ensure: { available: false, reason: 'model_not_ready' } });
  const post = await buildCapturePost(new Blob(['x']), {
    mimeType: 'audio/webm', encodeAudio: ENCODE, storage, log, engine: eng,
  });
  assert.equal(post.via, 'cloud');
  assert.equal(post.reason, 'model_not_ready');
  assert.equal(post.label, cloudFallbackLabel('model_not_ready'));
  assert.deepEqual(post.payload, { audioBase64: 'BASE64AUDIO', mimeType: 'audio/webm' });
  assert.ok(lines.some((l) => l.includes(CAPTURE_STT_TAG) && l.includes('model_not_ready')));
});

test('switch: flag ON + on-device transcription fails → labelled cloud fallback', async () => {
  const storage = memoryStorage();
  setSttEnabled(true, {}, storage);
  const { lines, log } = logCapture();
  const eng = fakeEngine({ transcribe: { available: false, reason: 'transcribe_failed', error: 'boom' } });
  const post = await buildCapturePost(new Blob(['x']), {
    mimeType: 'audio/ogg', encodeAudio: ENCODE, storage, log, engine: eng,
  });
  assert.equal(post.via, 'cloud');
  assert.equal(post.reason, 'transcribe_failed');
  assert.ok(post.label.includes('transcribe_failed'));
  assert.deepEqual(post.payload, { audioBase64: 'BASE64AUDIO', mimeType: 'audio/ogg' });
  assert.ok(lines.some((l) => l.includes('transcribe_failed')));
});

test('switch: engine throwing never breaks the capture — labelled cloud fallback', async () => {
  const storage = memoryStorage();
  setSttEnabled(true, {}, storage);
  const eng = { ensureModel: async () => { throw new Error('worker died'); }, transcribe: async () => ({ available: true, text: 'x' }) };
  const r = await transcribeCapture(new Blob(['x']), { storage, log: () => {}, engine: eng });
  assert.equal(r.mode, 'cloud');
  assert.match(r.reason, /capture_switch_error/);
});

// ─── 2a. Handler pin: Diary ─────────────────────────────────────────────

const realFetch = globalThis.fetch;
const realError = console.error;

function mockRes() {
  return {
    code: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}

async function withDiaryEnv(fn) {
  const saved = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    SHEETS_DIARY_WEBHOOK: process.env.SHEETS_DIARY_WEBHOOK,
  };
  process.env.ANTHROPIC_API_KEY = 'capture-test-anthropic';
  process.env.OPENAI_API_KEY = 'capture-test-openai';
  delete process.env.SHEETS_DIARY_WEBHOOK;
  console.error = () => {};
  try { return await fn(); } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

function stubFetch(calls) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('api.openai.com/v1/audio/transcriptions')) {
      return { ok: true, json: async () => ({ text: 'CLOUD TRANSCRIPT MARKER' }) };
    }
    if (u.includes('api.anthropic.com')) {
      const parsed = {
        date: '2026-10-25', time: '08:00', location: 'General', category: 'General',
        summary: 'stub', detail: 'stub', action_items: [], priority: 'Medium',
      };
      return { ok: true, json: async () => ({ content: [{ text: JSON.stringify(parsed) }] }) };
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
}

test('handler pin (Diary): a { text } post NEVER calls cloud transcription', async () => {
  await withDiaryEnv(async () => {
    const calls = [];
    stubFetch(calls);
    const res = mockRes();
    const spanish = 'Buenos días, necesito revisar el horario de ordeño.';
    await diaryHandler({ method: 'POST', body: { text: spanish } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.transcript, spanish);
    assert.equal(calls.filter((u) => u.includes('audio/transcriptions')).length, 0);
    assert.equal(calls.filter((u) => u.includes('api.anthropic.com')).length, 1);
  });
});

test('handler pin (Diary) CONTROL: an audio post still cloud-transcribes exactly once', async () => {
  await withDiaryEnv(async () => {
    const calls = [];
    stubFetch(calls);
    const res = mockRes();
    await diaryHandler({ method: 'POST', body: { audioBase64: 'AAAA', mimeType: 'audio/webm' } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.transcript, 'CLOUD TRANSCRIPT MARKER');
    assert.equal(calls.filter((u) => u.includes('audio/transcriptions')).length, 1);
  });
});

// ─── 2b. Handler pin: Actionable (child process, module mocks) ─────────

test('handler pin (Actionable): a { text } post NEVER calls cloud transcription; audio control calls it once', () => {
  const child = fileURLToPath(new URL('./fixtures/actionable-handler-child.mjs', import.meta.url));
  const run = spawnSync(process.execPath, ['--experimental-test-module-mocks', child], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(run.status, 0, `child failed:\n${run.stderr}\n${run.stdout}`);
  const line = run.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, `no JSON result from child:\n${run.stdout}`);
  const { textPost, audioPost } = JSON.parse(line);

  assert.equal(textPost.status, 200);
  assert.equal(textPost.ok, true);
  assert.equal(textPost.transcribeCalls, 0);
  // The Spanish text comes back as the transcript VERBATIM — not
  // translated, not re-transcribed.
  assert.match(textPost.transcript, /horario de ordeño/);

  assert.equal(audioPost.status, 200);
  assert.equal(audioPost.transcribeCalls, 1);
  assert.equal(audioPost.transcript, 'CLOUD TRANSCRIPT MARKER');
});

// ─── 3. Static wiring pins ──────────────────────────────────────────────

const captureSttJs = readFileSync(new URL('../public/capture-stt.js', import.meta.url), 'utf8');
const diaryPublic = readFileSync(new URL('../public/diary.html', import.meta.url), 'utf8');
const diaryRoot = readFileSync(new URL('../diary.html', import.meta.url), 'utf8');

test('wiring: both Diary pages route recordings through the capture switch', () => {
  for (const [name, src] of [['public/diary.html', diaryPublic], ['diary.html', diaryRoot]]) {
    assert.ok(src.includes("import('./capture-stt.js')"), `${name} imports the capture switch`);
    assert.ok(src.includes('buildCapturePost'), `${name} builds the post via the switch`);
    assert.ok(src.includes("post.via === 'on_device'"), `${name} handles the on-device path`);
    assert.ok(src.includes('post.label'), `${name} shows the labelled cloud fallback`);
    assert.ok(src.includes('audioBase64'), `${name} keeps the cloud audio post`);
  }
});

test('wiring: capture-stt is built on the Bite 1 engine and labels every cloud fallback', () => {
  assert.ok(captureSttJs.includes("from './stt.js'"));
  assert.ok(captureSttJs.includes('createSttEngine'));
  assert.ok(captureSttJs.includes('cloud transcription'));
  assert.ok(!captureSttJs.includes('audio/transcriptions'), 'client switch never calls a cloud STT API directly');
});
