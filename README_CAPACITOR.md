# ThinkinBuddy (Mark) — Android APK via Capacitor

**Strategy:** thin-shell remote-URL. The Capacitor WebView loads `https://thinkinbuddy.vercel.app` at runtime. No web assets are bundled. The Vercel deploy is completely unchanged.

---

## Prerequisites (install these first — NONE are present on this machine today)

| Tool | Version needed | Install |
|------|---------------|---------|
| **JDK 17** | exactly 17 (Gradle 8 + Capacitor 6 require it) | [Eclipse Temurin 17](https://adoptium.net/temurin/releases/?version=17) — installer sets `JAVA_HOME` |
| **Android Studio** | Hedgehog 2023.1+ | [developer.android.com/studio](https://developer.android.com/studio) — installs SDK, emulator, and Gradle |
| **Android SDK** (via Android Studio) | API 34 platform + build-tools 34.0.0 | SDK Manager inside Android Studio |
| **`ANDROID_HOME`** env var | points to SDK root | Android Studio sets it; verify: `echo $env:ANDROID_HOME` |

Node 24 and npm 11 are already present.

---

## One-time install steps (run in this repo root)

```powershell
# 1. Install Capacitor packages (adds @capacitor/core, /android, /camera,
#    /local-notifications, /push-notifications, @capacitor/cli)
npm install

# 2. Build the web bundle (Capacitor CLI needs a dist/ even in remote-URL mode)
npm run build

# 3. Add the Android platform (creates android/ directory)
npx cap add android
```

After step 3 you will have `android/` in this repo. That directory is
the full Gradle project — open it in Android Studio for signing config.

---

## AndroidManifest permissions (auto-added by plugins, verify after `cap add android`)

Capacitor plugins add these to `android/app/src/main/AndroidManifest.xml` automatically
when you run `npx cap sync`. Confirm they are present:

```xml
<!-- Camera / Photo / Video -->
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />

<!-- Local Notifications / Alarms (exact-alarm permission needed for Android 12+) -->
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

<!-- Push Notifications (FCM) -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="com.google.android.c2dm.permission.RECEIVE" />
```

---

## Sync web assets + build APK

```powershell
# After any web change: rebuild + sync
npm run build
npx cap sync android

# Open in Android Studio (full GUI — recommended for signing setup)
npx cap open android

# --- OR build from CLI (requires Android Studio + SDK installed) ---
cd android
.\gradlew assembleDebug           # debug APK → android/app/build/outputs/apk/debug/
.\gradlew assembleRelease         # unsigned release APK
.\gradlew bundleRelease           # signed AAB for Play Store (needs signing config below)
```

---

## Signing (your step — do NOT share keystore with this repo)

```powershell
# Generate a keystore once (keep the file + passwords somewhere safe)
keytool -genkey -v -keystore thinkinbuddy-release.jks `
  -alias thinkinbuddy -keyalg RSA -keysize 2048 -validity 10000

# In android/app/build.gradle add:
# signingConfigs {
#   release {
#     storeFile file('../../thinkinbuddy-release.jks')
#     storePassword "YOUR_STORE_PASS"
#     keyAlias "thinkinbuddy"
#     keyPassword "YOUR_KEY_PASS"
#   }
# }
# buildTypes { release { signingConfig signingConfigs.release } }
```

Then `.\gradlew bundleRelease` produces a signed AAB ready for Google Play.

---

## Push Notifications (Firebase)

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com).
2. Add an Android app with package name `com.thinkinbuddy.app`.
3. Download `google-services.json` → place in `android/app/`.
4. In JS call `PushNotifications.register()` — the plugin handles the FCM token.

---

## In-app JS usage (add to index.html script block or a future module)

```js
import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications } from '@capacitor/push-notifications';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';

// Schedule a local reminder
await LocalNotifications.schedule({
  notifications: [{
    title: 'ThinkinBuddy reminder',
    body: 'Time to reflect',
    id: 1,
    schedule: { at: new Date(Date.now() + 1000 * 60 * 60) }, // 1 hr from now
    sound: undefined,
  }]
});

// Register for push
await PushNotifications.requestPermissions();
await PushNotifications.register();

// Take a photo or pick from library
const image = await Camera.getPhoto({
  quality: 90,
  allowEditing: false,
  resultType: CameraResultType.DataUrl,
  source: CameraSource.Prompt,  // prompts user: camera vs library
});
// image.dataUrl is a base64 data URL
```

---

## What this does NOT affect

- `index.html` — untouched, still deployed to Vercel.
- `api/` serverless functions — untouched, still run on Vercel.
- `vite.config.js` / `public/` / `dist/` — unchanged.
- The PWA service worker (`public/sw.js`) — still registered for web users.
- `vercel.json` — unchanged.

The `android/` directory created by `npx cap add android` should be added to
`.gitignore` if you do not want the full Gradle project tracked in Git
(it is large). The `capacitor.config.ts` and the updated `package.json` are
the only committed artifacts needed to reproduce the scaffold.

---

## Current build-tooling status on this machine

| Tool | Status |
|------|--------|
| Node 24 / npm 11 | PRESENT |
| JDK 17 | **MISSING** |
| Android Studio / SDK | **MISSING** |
| Gradle | **MISSING** (bundled inside Android Studio) |
| `ANDROID_HOME` | **NOT SET** |

**A local APK build is NOT possible tonight.** Install JDK 17 + Android Studio first (30–60 min), then run the steps above.
