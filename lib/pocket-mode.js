// pocket-mode.js — keep ThinkinBuddy alive with the phone in your pocket.
//
// TROY'S ASK, and it is one sentence: "set ThinkinBuddy up just like Spotify."
// Meaning: lock the screen, put the phone away, and it keeps talking. Controls on
// the lock screen. It does not die because you stopped looking at it.
//
// WHY IT DID NOT ALREADY WORK. index.html speaks with window.speechSynthesis.
// Every mobile browser suspends that when the page is backgrounded or the screen
// locks — it is treated as page activity, not as media. There is no MediaSession,
// no wake lock and no audio element, so the OS has never been told this app is
// playing anything. To Android it looks like a web page that went idle.
//
// THE THREE PIECES, and what each one honestly buys:
//
//   1. MediaSession   — puts a real card on the lock screen with the buddy's name
//                       and working play/pause. This is what makes it FEEL like
//                       Spotify, and it is the piece that actually needs a silent
//                       audio element to exist at all.
//   2. Silent keeper  — a looping, inaudible audio element. This is the trick
//                       Spotify-style web apps use: the OS keeps a tab alive that
//                       is genuinely playing audio, and it will not keep one alive
//                       that merely wants to be. It is not a hack around a
//                       limitation, it is the documented way to declare "I am a
//                       media app".
//   3. Wake lock      — optional, and only while a conversation is actually
//                       running. Never held idle: a wake lock left on is a flat
//                       battery, which is worse than the problem.
//
// WHAT THIS DOES NOT PROMISE. On iOS, Safari suspends speechSynthesis on lock
// regardless — Apple gives web apps no way around it. This makes Android work
// properly and makes iOS behave as well as a web app is permitted to. Saying
// otherwise would be the kind of claim that gets found out at the worst moment.

const SILENT_WAV =
  // 1 second of silence, 8kHz mono. Small enough to inline, real enough that the
  // OS counts it as playback.
  'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQ4AAAAAAAAAAAAAAAAAAAAAAA==';

export function createPocketMode({
  appName = 'ThinkinBuddy',
  buddyName = 'Mark',
  onPlay = () => {},
  onPause = () => {},
} = {}) {
  let keeper = null;
  let wakeLock = null;
  let active = false;

  function ensureKeeper() {
    if (keeper) return keeper;
    keeper = new Audio(SILENT_WAV);
    keeper.loop = true;
    keeper.volume = 0.0001; // not 0 — some browsers treat a muted element as not playing
    keeper.setAttribute('playsinline', '');
    return keeper;
  }

  function describe(title, artist) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || `Talking with ${buddyName}`,
      artist: artist || appName,
      album: appName,
    });
  }

  function wireControls() {
    if (!('mediaSession' in navigator)) return;
    // A lock-screen button that does nothing is worse than no button, so both of
    // these are wired to the real conversation, not to the silent keeper.
    navigator.mediaSession.setActionHandler('play', () => { start(); onPlay(); });
    navigator.mediaSession.setActionHandler('pause', () => { stop(); onPause(); });
    navigator.mediaSession.setActionHandler('stop', () => { stop(); onPause(); });
  }

  async function takeWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {
      // Refused, or the tab is not visible. Not worth surfacing — the audio path
      // is what matters and it does not depend on this.
    }
  }

  function releaseWakeLock() {
    try { wakeLock?.release(); } catch {}
    wakeLock = null;
  }

  /**
   * Call this from a REAL TAP. Browsers will not let audio start otherwise, and a
   * pocket mode that silently failed to arm is exactly the class of lie this
   * project keeps finding.
   */
  async function start() {
    if (active) return { ok: true };
    try {
      await ensureKeeper().play();
    } catch (err) {
      return { ok: false, reason: `audio would not start: ${err.message}` };
    }
    active = true;
    describe();
    wireControls();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    await takeWakeLock();
    return { ok: true };
  }

  function stop() {
    if (!active) return;
    try { keeper?.pause(); } catch {}
    active = false;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    releaseWakeLock();
  }

  // Coming back from a lock screen drops the wake lock by design. Retake it only
  // if a conversation is still meant to be running.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && active) takeWakeLock();
  });

  return {
    start,
    stop,
    isActive: () => active,
    /** Update the lock-screen card, e.g. with what he just said. */
    setNowPlaying: (title, artist) => describe(title, artist),
    supported: {
      mediaSession: 'mediaSession' in navigator,
      wakeLock: 'wakeLock' in navigator,
    },
  };
}
