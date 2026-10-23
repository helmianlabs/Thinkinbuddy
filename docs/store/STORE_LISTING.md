# Store listing — ThinkinBuddy (DRAFT for Troy's approval)

Everything below is a draft. Nothing here has been submitted anywhere,
and no listing text goes live until Troy approves it. Feature claims
were checked against the code as of the store-prep bite — if a feature
isn't in the app today, it isn't in the description.

---

## Identity (set in code this bite)

| Field | Value |
|---|---|
| App name | ThinkinBuddy |
| Bundle id / package name | `com.helmianlabs.thinkinbuddy` |
| Config | `capacitor.config.ts` (`appId`, `appName`, server URL `https://thinkbuddy-sandy.vercel.app`) |

⚠️ **The bundle id becomes PERMANENT the moment the App Store app
record is created under it.** It can still be changed right up until
that record exists; after that, changing it means abandoning the
listing and starting a new one (losing reviews, rankings, and links).
Same on Play once the app is created with the package name. If Troy
wants a different id, decide BEFORE step 1 of the build checklist.

---

## Listing copy (draft)

**Name:** ThinkinBuddy

**Subtitle (App Store, ≤30 chars):** `Your buddy that remembers you`

**Short description (Play, ≤80 chars):**
`Talk or type to your AI buddy — it remembers, creates, and helps, with a parent safety mode.`

**Description (draft):**

> ThinkinBuddy is a friendly AI companion you can talk to out loud or
> type to — and unlike a fresh chatbot every time, your buddy
> remembers. Tell it once what matters to you and it keeps that memory
> for the next conversation.
>
> **Talk hands-free.** Hold a real voice conversation with your buddy,
> or type when that's easier.
>
> **A buddy that remembers.** ThinkinBuddy keeps the things you tell it
> — your projects, your people, what you're learning — and recalls
> them in later chats, so you never have to start from zero.
>
> **Create together.** Ask your buddy to make images and short videos
> from your ideas, right inside the chat.
>
> **Reminders that stick.** Your buddy can set reminders and alarms so
> the things you talk about actually happen.
>
> **Made for families, with a real safety lock.** A parent can turn on
> Safety Mode, protected by a parent PIN a child can't undo. Under it,
> extra guardrails apply and content checks run on what goes in and
> what comes back.
>
> **Simple subscription, no setup.** Download, create your account,
> subscribe — done. No API keys to hunt down, no servers to configure.
> Your plan includes a monthly credit allowance for chat, voice, and
> creations; extra credit packs are there if you want more videos.
> Power users can optionally bring their own provider keys under
> Settings → Advanced.
>
> **Helmian Connect (top plan).** On the Helmian Connect plan, your
> buddy can reach your own computer through the Helmian relay and lend
> a hand there — and nothing happens on your computer without your
> approval.

Claims check (for Troy, not listing copy): voice conversations
(ElevenLabs), persistent memory + recall (our database), image/video
creation (the generation handlers), reminders (local notifications),
Safety Mode + parent PIN (bites 2/5a/5b), hosted subscription with
metered credits + packs (bites 3/4), optional own-keys (Advanced tab),
Helmian Connect relay pairing (bite 7). Nothing here promises offline
mode, a kids-curriculum library, or human tutoring — the app doesn't
do those today.

**Keywords (App Store, ≤100 chars, draft):**
`ai companion,voice buddy,ai friend,memory,study buddy,reminders,kids safe,family,chat,creator`

**Support URL:** `[PLACEHOLDER — Troy: a public support page/email URL]`
**Privacy policy URL:** `[PLACEHOLDER — host docs/store/PRIVACY_POLICY.md content at a public URL]`
**Marketing URL:** `[PLACEHOLDER — optional]`

---

## Age rating — BOTH paths, Troy decides

**⚠️ DECISION NEEDED — Troy picks the path. Nobody else picks it.**

### Path A — Kids-directed listing (Apple Kids Category / Play Families, COPPA-heavy)

What it means: the app is marketed *to children* (under 13).

- Apple Kids Category rules apply: no third-party advertising or
  analytics SDKs, parental gates for purchases/links, apps must not
  send personally identifiable info to third parties without a
  compliant consent flow.
- COPPA (US) applies in full: verifiable parental consent before
  collecting a child's personal information — and this app collects
  voice audio and chat content by design. That means a real parental
  consent flow (not a checkbox), data-retention limits, and deletion
  rights for the child's data specifically.
- Play's Designed for Families program adds its own ad/content rules.
- **The hard problem:** our chat/voice pipeline sends content to
  third-party AI providers (LLM providers, ElevenLabs, OpenAI
  moderation). Kids-directed rules make third-party sharing of a
  child's data the central compliance question — this path needs a
  lawyer review of every processor before submission, and possibly
  processor changes.

### Path B — Family / 13+ listing, parent is the account holder (lighter)

What it means: the *account holder and subscriber is the parent*;
the app is listed for a general/family audience with an age rating
that reflects online AI interaction, not a kids-directed app.

- No Kids Category / Designed for Families enrollment; standard
  review. Age rating lands in the teen band on both stores' rating
  questionnaires (user-generated/AI content + interaction drive it).
- COPPA's kids-directed triggers don't apply the same way when the
  product isn't directed at under-13s — the parent creates the
  account, holds the password, sets the PIN, and controls Safety
  Mode. (The profile age bands, including child bands, stay as a
  *parent's setting for their household*, which is exactly how the
  app is built.)
- Safety Mode + PIN + moderation remain selling points, not
  compliance crutches.
- Still required either way (already built): privacy policy,
  in-app account deletion, data-safety declarations below.

**Muse's note (not a decision):** the app as built — parent account,
parent PIN, parent-controlled safety — matches Path B's shape. Path A
is a bigger legal build than a listing choice. Troy decides; the
rating questionnaires get answered to match the choice.

---

## Privacy declarations — mapped from the real data flows

These answers come from the code, not from aspiration. Reviewers (and
Troy) should be able to trace each line to a handler.

### What the app collects and why

| Data | Why | Where it goes |
|---|---|---|
| Account email + password (scrypt-hashed, never stored in plain text) | Sign-in | Our database only |
| Profile: display name, age band, "about me" | Personalize the buddy; age band drives safety | Our database |
| Chat text + conversation history | The conversation itself + the buddy's memory/recall | Our database; each message is sent to the selected AI provider (OpenAI / Anthropic / Google) to generate the reply |
| Voice audio | Voice conversation | ElevenLabs (speech + voice reply); conversation text is stored like chat |
| Chat input + generated replies | Safety moderation | OpenAI Moderation API (free tier) |
| Image/video prompts + generated media | Creation features | Generation providers (Replicate, Runway, HeyGen); results stored in Vercel Blob |
| Parent PIN (scrypt-hashed) | Lock safety settings | Our database (hash only) |
| Optional: user's own provider API keys | Advanced BYO-key mode | Stored encrypted per tenant (`user_keys`), used only to call that provider for that user |
| Usage counts (feature, units, cost) | Metering the monthly credit bucket | Our database |
| Purchase state (plan, status, period) | Entitlements | RevenueCat processes the purchase with Apple / Google / Stripe; we receive plan state by webhook — **we never see or store card numbers** |
| Connected-computer info (Helmian Connect only): device label + pairing state | Relay pairing | Our database; relay traffic passes to the user's own paired computer, actions need the user's approval (Guard) |

### Apple Privacy Nutrition Label (proposed answers)

- **Contact Info → Email Address:** Linked to identity, App Functionality.
- **User Content → Other User Content** (chats, voice, creations, profile
  notes): Linked to identity, App Functionality.
- **Identifiers → User ID** (account/tenant id, RevenueCat app user id):
  App Functionality.
- **Purchases → Purchase History:** App Functionality (plan/entitlement state).
- **Usage Data → Product Interaction** (metering counts): App Functionality.
- **NOT collected:** location, contacts, browsing history, health,
  financial credentials, advertising data.
- **Tracking:** No. No third-party advertising, no ad SDKs, no data
  sold, no cross-app/website tracking.

### Play Data Safety (proposed answers)

- Data shared with third parties: the processors above (AI providers,
  ElevenLabs, OpenAI moderation, generation providers, RevenueCat) —
  declared as service providers processing on our behalf, not a sale.
- Data encrypted in transit: Yes (HTTPS everywhere).
- Account creation: Yes (email + password).
- **Account deletion: Yes — in-app (Settings → Account & Safety →
  Delete my account) and it erases the tenant's data server-side.**
- No ads. No data sold.

---

## Build route — what stands between this repo and a submitted app

**No Mac is required.** The iOS build needs a macOS build *route*, not
a Mac on a desk:

- **Troy's existing First Use pipeline** — the third-party build
  website (time-limited sessions) Troy already used to produce First
  Use's IPA without a Mac. First Use is live on Play with Apple
  review pending (expedited), so this route is proven by Troy's own
  shipping history.
- **Or a cloud-Mac service** (e.g. MacinCloud / similar) for the same
  steps.

**Route: TBD — being settled by parallel research.** The steps below
are route-agnostic; wherever they run, they run on macOS.

### Checklist (in order)

1. **[Troy]** Decide the age-rating path above + the subscription
   prices (billing sheet) — these gate the listing, not the build.
2. **[Troy]** Apple Developer Program enrollment + App Store Connect
   app record under bundle id `com.helmianlabs.thinkinbuddy`
   (PERMANENT — see the warning at the top), Play Console app under
   the same package name.
3. **[Build route]** `npm install` (already done once here; the lock
   pins Capacitor 6.2.1 across core/cli/android/ios — keep
   TypeScript on the 5.x line: Capacitor CLI 6.2's config loader
   breaks on newer TypeScript majors) → `npx cap sync ios` → open
   `ios/App/App.xcworkspace` in Xcode → signing with Troy's Apple
   team → archive + upload.
   - `npx cap sync` regenerates `ios/App/App/public/` (the web bundle
     copy) — it is intentionally NOT committed to git, same as
     `dist/`.
   - The 4 stock Capacitor template images (app icon + splash PNGs)
     are not in git either — the connector push path carries text
     only. Restore the stock ones from the Capacitor template or,
     better, generate real ThinkinBuddy assets with
     `@capacitor/assets` before the first archive. **An archive with
     the placeholder icon should not be submitted.**
4. **[Troy]** RevenueCat + store products per
   `docs/store/BILLING_SETUP.md` (exact product ids live there).
5. **[Troy]** Screenshots (the First Use pipeline produced these too),
   listing text approval (this doc), privacy policy hosted at a
   public URL, support URL live.
6. **[Troy]** Run the migrations (`sql/store/001`–`005`) against the
   hosted database + set `SESSION_SECRET` in the live deployment so
   accounts mode is actually on for the store build (until then the
   shipped app would run in legacy single-user mode with no
   accounts).
7. Submit for review; answer the rating questionnaires per the
   chosen path.

### Honest status (store-prep bite)

- iOS scaffold generated by the real `npx cap add ios` (Capacitor CLI
  6.2.1) on a Linux VM — **no iOS build has been run or claimed**.
- `NSMicrophoneUsageDescription` is in the Info.plist (voice is the
  one capture feature the code uses). Camera/photo usage strings were
  deliberately NOT added: no code path calls the Camera plugin or a
  photo picker (the `@capacitor/camera` package is present but
  unused; if a photo feature ships later, its strings go in then).
- Android remains as it was; this bite touched nothing under
  `android/`.
