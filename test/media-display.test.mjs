// test/media-display.test.mjs — media display + casting start bite
// (2026-10-23): live media must come up FULL-SCREEN on a phone, and
// videos get a working cast start.
//
// What this pins, from the audit that preceded it:
//   - Live VIDEO already took the full viewport via showVideo's fixed
//     inset-0 overlay on #mediaArea, but never called the real
//     Fullscreen API. Live IMAGES rendered in a small card (#mediaArea
//     capped at max-width:340px) with no tap-to-expand.
//   - Casting was entirely ABSENT: no Cast SDK, no Remote Playback
//     API, no AirPlay picker. All generated media are permanent
//     public Vercel Blob URLs — which is what makes the share-the-URL
//     fallback viable.
//
// The fix under test (index.html only):
//   - showMedia presents the image in the SAME full-viewport fixed
//     overlay pattern as showVideo; tap the image (or ✕) closes.
//   - Both live overlays, and the gallery lightbox, ask for the real
//     Fullscreen API via enterOverlayFullscreen (feature-detected,
//     try/caught); hideMedia/closeLightbox exit it cleanly.
//   - ONE cast button per surface (#mediaCastBtn for live media,
//     #galleryLightboxCast in the lightbox) wired by
//     wireMediaCastButton: route order remote (Remote Playback,
//     Chrome/Android) → airplay (Safari picker) → share ("Watch on
//     TV": share sheet or copy the public URL). No URL → null route
//     → the button is not shown at all.
//
// No DOM, no browser: the helpers are sliced out of index.html and
// run under node:vm against fake elements — the same pattern as
// test/session-identity.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const a = indexHtml.indexOf(startMarker);
  assert.ok(a >= 0, `marker not found: ${startMarker}`);
  const b = indexHtml.indexOf(endMarker, a);
  assert.ok(b > a, `end marker not found after: ${startMarker}`);
  return indexHtml.slice(a, b + endMarker.length);
}

const MEDIA_URL = 'https://blob.example/media/clip.mp4';

// ─── vm harness for the fullscreen/cast helpers ────────────────────

function loadHelpers() {
  const src = sliceBetween('function enterOverlayFullscreen', '// ─── end media display helpers ───');
  const sandbox = {
    console,
    setTimeout,
    document: { fullscreenElement: null, exitFullscreen: null },
    navigator: {},
  };
  sandbox.window = sandbox;
  vm.runInNewContext(src, sandbox);
  return sandbox;
}

// ─── (1) Cast route order: remote → airplay → share → null ─────────

test('pickCastRoute orders remote, then AirPlay, then share, then null', () => {
  const s = loadHelpers();
  const remoteVideo = { remote: { prompt: () => Promise.resolve() } };
  const airplayVideo = { webkitShowPlaybackTargetPicker: () => {} };
  const bothVideo = { remote: remoteVideo.remote, webkitShowPlaybackTargetPicker: airplayVideo.webkitShowPlaybackTargetPicker };
  const plainVideo = {};

  assert.equal(s.pickCastRoute(bothVideo, MEDIA_URL), 'remote', 'Remote Playback beats AirPlay and share');
  assert.equal(s.pickCastRoute(remoteVideo, MEDIA_URL), 'remote');
  assert.equal(s.pickCastRoute(airplayVideo, MEDIA_URL), 'airplay', 'AirPlay beats the share fallback');
  assert.equal(s.pickCastRoute(plainVideo, MEDIA_URL), 'share', 'no cast API: share the public URL');
  assert.equal(s.pickCastRoute(null, MEDIA_URL), 'share', 'still images only ever get the share route');
  assert.equal(s.pickCastRoute(plainVideo, ''), null, 'no media URL: no route');
  assert.equal(s.pickCastRoute(null, ''), null);
  assert.equal(s.pickCastRoute(null, undefined), null);
});

// ─── (2) Click behavior per route ──────────────────────────────────

test('castButtonClick drives prompt / picker / share-sheet / clipboard in order', async () => {
  const s = loadHelpers();

  // Remote: prompt() exactly once.
  let promptCalls = 0;
  const remoteVideo = { remote: { prompt: () => { promptCalls++; return Promise.resolve(); } } };
  assert.equal(s.castButtonClick(remoteVideo, MEDIA_URL, null), 'remote');
  assert.equal(promptCalls, 1);

  // AirPlay: the picker exactly once.
  let pickerCalls = 0;
  const airplayVideo = { webkitShowPlaybackTargetPicker: () => { pickerCalls++; } };
  assert.equal(s.castButtonClick(airplayVideo, MEDIA_URL, null), 'airplay');
  assert.equal(pickerCalls, 1);

  // Share sheet receives the media's public URL.
  const shared = [];
  s.navigator = { share: (args) => { shared.push(args); return Promise.resolve(); } };
  assert.equal(s.castButtonClick({}, MEDIA_URL, null), 'share-sheet');
  assert.equal(shared.length, 1);
  assert.equal(shared[0].url, MEDIA_URL);

  // No share sheet: the URL is copied for the TV's browser.
  const copied = [];
  s.navigator = { clipboard: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } };
  const label = { textContent: '📺 TV' };
  assert.equal(s.castButtonClick(null, MEDIA_URL, label), 'copied');
  assert.deepEqual(copied, [MEDIA_URL]);
  assert.equal(label.textContent, 'Link copied — open it on your TV');

  // No URL: nothing is called, route is null.
  s.navigator = { share: () => { throw new Error('must not be called'); } };
  assert.equal(s.castButtonClick({}, '', null), null);
});

// ─── (3) Button wiring: no route → not rendered ────────────────────

test('wireMediaCastButton hides the button when there is no route, wires it when there is', () => {
  const s = loadHelpers();

  const btn1 = { style: {}, onclick: null };
  assert.equal(s.wireMediaCastButton(btn1, {}, ''), null, 'no URL → no route');
  assert.equal(btn1.style.display, 'none', 'button not rendered without a media URL');
  assert.equal(btn1.onclick, null);

  const shared = [];
  s.navigator = { share: (args) => { shared.push(args); return Promise.resolve(); } };
  const btn2 = { style: {}, onclick: null, textContent: '📺 TV' };
  assert.equal(s.wireMediaCastButton(btn2, null, MEDIA_URL), 'share', 'image gets the share affordance');
  assert.equal(btn2.style.display, 'flex');
  assert.equal(typeof btn2.onclick, 'function');
  btn2.onclick();
  assert.equal(shared.length, 1, 'clicking the wired button shares the URL');

  // Remote route: watchAvailability interest is registered at wire
  // time (the documented pre-step), prompt() fires on click.
  let watchCalls = 0, promptCalls = 0;
  const remoteVideo = {
    remote: {
      watchAvailability: (cb) => { watchCalls++; assert.equal(typeof cb, 'function'); return Promise.resolve(1); },
      prompt: () => { promptCalls++; return Promise.resolve(); },
    },
  };
  const btn3 = { style: {}, onclick: null };
  assert.equal(s.wireMediaCastButton(btn3, remoteVideo, MEDIA_URL), 'remote');
  assert.equal(watchCalls, 1, 'watchAvailability registered when the button is wired');
  btn3.onclick();
  assert.equal(promptCalls, 1);
});

// ─── (4) Fullscreen API: feature-detected, invoked, exited ─────────

test('enterOverlayFullscreen is feature-detected and invoked; exit pairs with it', () => {
  const s = loadHelpers();

  let fsCalls = 0;
  const el = { requestFullscreen: () => { fsCalls++; return Promise.resolve(); } };
  s.enterOverlayFullscreen(el);
  assert.equal(fsCalls, 1, 'requestFullscreen invoked on the overlay element');

  // Already fullscreen: no second request.
  s.document.fullscreenElement = el;
  s.enterOverlayFullscreen(el);
  assert.equal(fsCalls, 1, 'no re-request while already fullscreen');
  s.document.fullscreenElement = null;

  // No API at all (e.g. iPhone Safari for arbitrary elements): a
  // silent no-op — the fixed overlay is the fallback.
  s.enterOverlayFullscreen({});
  s.enterOverlayFullscreen(null);

  // A throwing/rejecting requestFullscreen is swallowed.
  s.enterOverlayFullscreen({ requestFullscreen: () => { throw new Error('denied'); } });
  s.enterOverlayFullscreen({ requestFullscreen: () => Promise.reject(new Error('denied')) });

  // Exit only fires while something is fullscreen.
  let exitCalls = 0;
  s.document.exitFullscreen = () => { exitCalls++; return Promise.resolve(); };
  s.exitOverlayFullscreen();
  assert.equal(exitCalls, 0, 'no exit when nothing is fullscreen');
  s.document.fullscreenElement = el;
  s.exitOverlayFullscreen();
  assert.equal(exitCalls, 1, 'exit invoked while fullscreen');
});

// ─── (5) Static pins on the display functions ──────────────────────

test('showMedia uses the full-viewport overlay path, tap-to-close, cast share, fullscreen', () => {
  const body = sliceBetween('function showMedia', 'function showVideo');
  assert.ok(body.includes('position:fixed; inset:0'), 'image presented in the fixed full-viewport overlay, not the 340px card');
  assert.ok(body.includes('width:100vw; height:100vh'), 'image fills the viewport');
  assert.ok(body.includes('object-fit:contain'), 'image letterboxed like the video overlay');
  assert.ok(body.includes('enterOverlayFullscreen(area)'), 'image overlay requests the real Fullscreen API');
  assert.ok(body.includes('wireMediaCastButton(castBtn, null, url)'), 'image overlay offers the Watch-on-TV share affordance');
  assert.ok(body.includes('img.onclick'), 'tap on the image closes the overlay');
});

test('showVideo keeps its overlay and gains cast wiring + fullscreen', () => {
  const body = sliceBetween('function showVideo', 'function hideMedia');
  assert.ok(body.includes('position:fixed; inset:0'), 'video overlay pattern unchanged');
  assert.ok(body.includes('enterOverlayFullscreen(area)'), 'video overlay requests the real Fullscreen API');
  assert.ok(body.includes('wireMediaCastButton(castBtn, vid, url)'), 'video overlay wires the cast button');
});

test('hideMedia exits fullscreen and hides the cast button', () => {
  const body = sliceBetween('function hideMedia', "addEventListener('click', hideMedia)");
  assert.ok(body.includes('exitOverlayFullscreen()'), 'closing the overlay exits fullscreen cleanly');
  assert.ok(body.includes("castBtn.style.display = 'none'"), 'cast button hidden with the overlay');
});

test('the Fullscreen request is guarded inside the helper, not called bare', () => {
  const helpers = sliceBetween('function enterOverlayFullscreen', '// ─── end media display helpers ───');
  assert.ok(helpers.includes('el.requestFullscreen || el.webkitRequestFullscreen'), 'standard + webkit-prefixed request feature-detected');
  assert.ok(helpers.includes("typeof req !== 'function'"), 'missing API is a no-op');
  assert.ok(helpers.includes('videoEl.remote') && helpers.includes('webkitShowPlaybackTargetPicker'), 'both cast APIs are probed by the chooser');
});

// ─── (6) Markup + lightbox wiring ──────────────────────────────────

test('exactly one cast button per surface, and the lightbox wires it', () => {
  const occurrences = (needle) => indexHtml.split(needle).length - 1;
  assert.equal(occurrences('id="mediaCastBtn"'), 1, 'one cast button for live media');
  assert.equal(occurrences('id="galleryLightboxCast"'), 1, 'one cast button in the gallery lightbox');

  const lightbox = sliceBetween('function openLightbox', 'galleryLbCloseEl.addEventListener');
  assert.ok(lightbox.includes('wireMediaCastButton(galleryLbCastEl'), 'lightbox wires its cast button on open');
  assert.ok(lightbox.includes("item.type === 'video' ? galleryLbVideo : null"), 'only lightbox videos get the video cast routes; images share');
  assert.ok(lightbox.includes("galleryLbCastEl.style.display = 'none'"), 'lightbox cast button hidden again on close');
});
