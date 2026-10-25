// test/fixtures/actionable-handler-child.mjs — NOT a test file (no
// .test.mjs suffix): a child process driven by
// test/capture-stt.test.mjs with `node
// --experimental-test-module-mocks`, because module mocking needs that
// flag and the suite's command line is fixed.
//
// It runs the REAL server/handlers/actionable.js with:
//   - lib/actionable/db.js, docs.js, google-auth.js replaced by
//     in-memory fakes (no Postgres, no Google in the unit suite),
//   - lib/actionable/extract.js = the REAL module with ONE wrap:
//     transcribeAudio (the cloud Whisper call) is counted and returns
//     a marker transcript, so a regression that routes { text } posts
//     through cloud transcription is caught by the count,
//   - ACTIONABLE_LLM_PROVIDER=rules, so extraction is the local rules
//     engine — the only network-shaped call left in the handler's path
//     is the one being counted.
// Output: one JSON line on stdout, { textPost, audioPost } summaries.
import { mock } from 'node:test';

process.env.ACTIONABLE_LLM_PROVIDER = 'rules';
// Set on purpose: if the handler decided to transcribe, the key check
// would pass and the counted function would run — the pin cannot pass
// vacuously through a missing-key shortcut.
process.env.OPENAI_API_KEY = 'capture-test-key-not-real';

const realExtract = await import('../../lib/actionable/extract.js');
let transcribeCalls = 0;
mock.module('../../lib/actionable/extract.js', {
  cache: false,
  exports: {
    ...realExtract,
    transcribeAudio: async () => { transcribeCalls++; return 'CLOUD TRANSCRIPT MARKER'; },
  },
});
mock.module('../../lib/actionable/db.js', {
  cache: false,
  exports: {
    listProjects: async () => [],
    ensureSeedProjects: async () => {},
    listKnownTags: async () => [],
    listKnownPeople: async () => [],
    getSettings: async () => ({ timezone: 'America/Denver' }),
    saveEntry: async (row) => ({ id: 'entry-1', capturedAt: row.capturedAt || new Date().toISOString() }),
    attachOutputs: async () => {},
  },
});
mock.module('../../lib/actionable/docs.js', {
  cache: false,
  exports: {
    writeGoogleDoc: async () => ({ ok: false, reason: 'not_configured' }),
    writeDocViaWebhook: async () => ({ ok: false, reason: 'not_configured' }),
    shouldAlsoLogToSheet: () => false,
    appendToSheet: async () => ({ ok: false, reason: 'not_applicable' }),
    appendToSheetWebhook: async () => ({ ok: false, reason: 'not_applicable' }),
  },
});
mock.module('../../lib/actionable/google-auth.js', {
  cache: false,
  exports: { googleStatus: async () => ({ connected: false }) },
});

const handler = (await import('../../server/handlers/actionable.js')).default;

function mockRes() {
  return {
    code: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}

async function post(body) {
  const res = mockRes();
  await handler({ method: 'POST', headers: {}, body }, res);
  return res;
}

const spanish = 'Buenos días. Necesito revisar el horario de ordeño y confirmar la entrega de leche para el viernes.';
const textRes = await post({ userId: 'troy', text: spanish, source: 'app' });
const afterText = transcribeCalls;
const audioRes = await post({ userId: 'troy', audioBase64: 'AAAA', mimeType: 'audio/webm', source: 'app' });

console.log(JSON.stringify({
  textPost: {
    status: textRes.code,
    ok: textRes.body?.ok === true,
    transcript: textRes.body?.transcript || null,
    transcribeCalls: afterText,
  },
  audioPost: {
    status: audioRes.code,
    ok: audioRes.body?.ok === true,
    transcript: audioRes.body?.transcript || null,
    transcribeCalls,
  },
}));
