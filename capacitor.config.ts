import { CapacitorConfig } from '@capacitor/cli';

/**
 * ThinkinBuddy (Mark) — Capacitor Android wrapper
 *
 * STRATEGY: thin-shell / remote-URL mode.
 * The app loads https://thinkbuddy-sandy.vercel.app inside a native WebView.
 * No assets are bundled locally. This means:
 *   - Zero change to the Vercel web deploy
 *   - APK auto-gets every web update without a Play Store re-release
 *   - The native layer is ONLY here for device permissions:
 *       local-notifications, alarms, camera, photo/video, push
 *
 * To switch to a BUNDLED build (full offline, no network dependency):
 *   1. Run: npm run build   (produces dist/)
 *   2. Change server.url below to:   webDir: 'dist'   (and remove server block)
 *   3. Run: npx cap sync android
 */
const config: CapacitorConfig = {
  // appId is the store bundle/package id. PERMANENT once the App Store /
  // Play app record exists under it — changing it later means a brand
  // new store listing (bite 6, docs/store/STORE_LISTING.md).
  appId: 'com.helmianlabs.thinkinbuddy',
  appName: 'ThinkinBuddy',

  // Remote-URL shell — loads live Vercel site
  server: {
    url: 'https://thinkbuddy-sandy.vercel.app',
    cleartext: false,   // HTTPS only — never allow HTTP
    androidScheme: 'https',
  },

  // webDir is still required by the CLI even in remote-URL mode.
  // Point it at dist/ so `npx cap sync` has a valid directory to reference.
  // Run `npm run build` once before `npx cap add android` / `npx cap sync`.
  webDir: 'dist',

  android: {
    // Gradle build flavor — release or debug
    buildOptions: {
      releaseType: 'AAB',   // Play Store needs AAB; use 'APK' for sideload
    },
  },

  plugins: {
    // ── Local Notifications (alarms / scheduled reminders) ──────────────────
    LocalNotifications: {
      smallIcon: 'ic_stat_icon_config_sample',
      iconColor: '#488AFF',
      sound: 'beep.wav',
    },

    // ── Push Notifications ───────────────────────────────────────────────────
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },

    // ── Camera / Photo / Video ───────────────────────────────────────────────
    // No config needed here — permissions are declared in AndroidManifest.xml.
    // The JS API uses CapacitorCamera.getPhoto() / .pickImages() / .pickLimitedLibraryPhotos()
  },
};

export default config;
