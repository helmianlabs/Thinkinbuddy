// public/stt-worker.js — the Web Worker half of public/stt.js
// (Whisper Bite 1: on-device speech-to-text, behind a flag, no callers
// in the shipped pages yet).
//
// ─── The loading pattern (proven by the Bite 0 spike; do not reorder) ──
// 1. self.onmessage is installed FIRST — textually and at runtime —
//    before any dynamic module load is initiated. The Transformers.js
//    library is a large async load; a message posted before a handler
//    exists is lost, and the load hangs with no error anywhere. The
//    library load does not even START until the first 'load' message
//    arrives with its config; handlers queue behind the promises the
//    loads create. (The function declarations below are hoisted, which
//    is why the handler can sit above them.)
// 2. The library is the BUNDLED build (transformers.min.js), loaded
//    from the config's libraryUrl. The .web variant of the bundle
//    imports a bare specifier and dies silently inside a module
//    worker — it must never be the libraryUrl (the default in stt.js
//    names the bundled build).
// 3. The bundle otherwise hardcodes its ONNX Runtime wasm URL to a
//    third-party CDN, so env.backends.onnx.wasm.wasmPaths is set
//    EXPLICITLY from the config before the pipeline is created.
// 4. Model files cache in the browser Cache API
//    (env.useBrowserCache), which is what makes cancel/resume cheap:
//    cancelling terminates this worker, completed files stay cached,
//    and a fresh worker's load skips them (see stt.js header).
//
// ─── The language law, enforced again here ─────────────────────────────
// The main thread pins the language (stt.js buildTranscribeOptions).
// This worker re-validates every transcribe message with the shared
// validateTranscribeOptions() and REFUSES anything that is not
// task:'transcribe' with a concrete pinned language name. There is no
// code path in this file that calls the model with an auto/unset
// language or the translate task — the Bite 0 spike proved that path
// silently translates Spanish instead of transcribing it.
//
// Protocol (main → worker):
//   { type:'load', id, config:{ modelId, dtype, device, libraryUrl,
//     wasmPaths, remoteHost, useBrowserCache } }
//   { type:'transcribe', id, audio:ArrayBuffer (Float32 PCM 16 kHz),
//     options }  — options come from buildTranscribeOptions()
//   { type:'dispose' }
// Protocol (worker → main):
//   { type:'progress', id, file, loaded, total, status }
//   { type:'loaded', id, totalBytes }
//   { type:'result', id, text, language }
//   { type:'error', id, message }

let sharedPromise = null;   // ./stt.js (validation + shared constants)
let libPromise = null;      // the Transformers.js library
let transcriberPromise = null;
let transcriber = null;

// Installed FIRST — before loadShared()/loadLibrary() are ever called.
self.onmessage = (e) => { route(e.data); };

// Kick off the small shared module only now that the handler exists;
// the big library load still waits for the first 'load' message and
// its config.
loadShared();

function loadShared() {
  if (!sharedPromise) sharedPromise = import('./stt.js');
  return sharedPromise;
}

async function loadLibrary(cfg) {
  if (!libPromise) {
    libPromise = (async () => {
      const lib = await import(cfg.libraryUrl);
      // Trap 3 (see header): never let the bundle's hardcoded CDN
      // default decide where the ONNX Runtime wasm comes from.
      lib.env.backends.onnx.wasm.wasmPaths = cfg.wasmPaths;
      lib.env.remoteHost = cfg.remoteHost || 'https://huggingface.co';
      lib.env.allowLocalModels = false;
      lib.env.useBrowserCache = cfg.useBrowserCache !== false;
      return lib;
    })();
  }
  return libPromise;
}

async function loadModel(msg) {
  const cfg = msg.config || {};
  const { pipeline } = await loadLibrary(cfg);
  if (!transcriberPromise) {
    const totals = {};
    transcriberPromise = pipeline('automatic-speech-recognition', cfg.modelId, {
      dtype: cfg.dtype || 'q8',
      device: cfg.device || 'wasm',
      progress_callback: (p) => {
        if (p && p.file) {
          if (typeof p.total === 'number') totals[p.file] = p.total;
          self.postMessage({
            type: 'progress', id: msg.id, file: p.file,
            loaded: p.loaded || 0, total: p.total || 0, status: p.status || 'progress',
          });
        }
      },
    }).then((t) => {
      transcriber = t;
      const totalBytes = Object.values(totals).reduce((a, b) => a + b, 0);
      self.postMessage({ type: 'loaded', id: msg.id, totalBytes });
      return t;
    });
  } else {
    // Already loaded (e.g. a second ensureModel on this worker):
    // report ready immediately; cached files made this cheap.
    await transcriberPromise;
    self.postMessage({ type: 'loaded', id: msg.id, totalBytes: 0 });
  }
  return transcriberPromise;
}

async function runTranscribe(msg) {
  if (!transcriber) throw new Error('model_not_loaded');
  const shared = await loadShared();
  const check = shared.validateTranscribeOptions(msg.options);
  if (!check.ok) {
    // The language law fails closed: no pinned language, no model call.
    throw new Error(`transcribe_options_rejected:${check.reasons.join(',')}`);
  }
  const audio = new Float32Array(msg.audio);
  const out = await transcriber(audio, {
    task: 'transcribe',
    language: msg.options.language,
    chunk_length_s: msg.options.chunk_length_s ?? 30,
    stride_length_s: msg.options.stride_length_s ?? 5,
  });
  self.postMessage({
    type: 'result', id: msg.id,
    text: (out && out.text) || '',
    language: msg.options.language,
  });
}

async function route(msg) {
  try {
    if (msg.type === 'load') {
      await loadModel(msg);
    } else if (msg.type === 'transcribe') {
      await runTranscribe(msg);
    } else if (msg.type === 'dispose') {
      if (transcriber && typeof transcriber.dispose === 'function') {
        try { await transcriber.dispose(); } catch { /* best effort */ }
      }
      transcriber = null;
      transcriberPromise = null;
    }
  } catch (err) {
    self.postMessage({
      type: 'error', id: msg && msg.id,
      message: String((err && err.message) || err),
    });
  }
}
