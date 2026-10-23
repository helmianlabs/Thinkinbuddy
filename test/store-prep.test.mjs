// test/store-prep.test.mjs — store-prep bite (iOS platform + listings).
// STATIC checks only: this environment has no Xcode and no iOS build
// was run. What these tests prove: the Capacitor config the CLI itself
// parsed (ios/App/App/capacitor.config.json is written BY
// `npx cap add ios` from capacitor.config.ts) carries the store
// identity — appId com.helmianlabs.thinkinbuddy, appName ThinkinBuddy,
// live server hostname thinkbuddy-sandy.vercel.app — the iOS platform
// dependency is on the same 6.x line as Android, and the generated
// Info.plist carries the microphone usage string for the one capture
// feature the code actually uses (voice) and NO camera/photo strings
// (no code path calls the Camera plugin or a photo picker — claiming
// them would misstate the app's access).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('capacitor.config.ts carries the store identity and the live hostname', () => {
  const src = read('capacitor.config.ts');
  assert.ok(src.includes("appId: 'com.helmianlabs.thinkinbuddy'"));
  assert.ok(src.includes("appName: 'ThinkinBuddy'"));
  assert.ok(src.includes("url: 'https://thinkbuddy-sandy.vercel.app'"));
  // The dead hostname the audit flagged must not be the server URL.
  assert.ok(!src.includes('thinkinbuddy.vercel.app'));
});

test('the CLI-parsed iOS config (capacitor.config.json) parses and matches', () => {
  const path = new URL('../ios/App/App/capacitor.config.json', import.meta.url);
  assert.ok(existsSync(path), 'ios platform scaffold exists (npx cap add ios)');
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(cfg.appId, 'com.helmianlabs.thinkinbuddy');
  assert.equal(cfg.appName, 'ThinkinBuddy');
  assert.equal(cfg.server.url, 'https://thinkbuddy-sandy.vercel.app');
});

test('the Xcode project carries the same bundle id', () => {
  const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
  assert.ok(pbx.includes('PRODUCT_BUNDLE_IDENTIFIER = com.helmianlabs.thinkinbuddy;'));
});

test('@capacitor/ios is a dependency on the same 6.x line as @capacitor/android', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies['@capacitor/ios'], 'ios dependency present');
  assert.match(pkg.dependencies['@capacitor/ios'], /^\^?6\./);
  assert.match(pkg.dependencies['@capacitor/android'], /^\^?6\./);
  assert.ok(pkg.dependencies['@revenuecat/purchases-capacitor'], 'RevenueCat plugin present');
});

test('Info.plist has the microphone usage string, character for character', () => {
  const plist = read('ios/App/App/Info.plist');
  assert.ok(plist.includes('<key>NSMicrophoneUsageDescription</key>'));
  assert.ok(plist.includes('<string>ThinkinBuddy listens so you can talk to your buddy hands-free.</string>'));
});

test('Info.plist claims NO camera or photo-library access (the code never uses them)', () => {
  const plist = read('ios/App/App/Info.plist');
  assert.ok(!plist.includes('NSCameraUsageDescription'));
  assert.ok(!plist.includes('NSPhotoLibraryUsageDescription'));
  assert.ok(!plist.includes('NSPhotoLibraryAddUsageDescription'));
});
