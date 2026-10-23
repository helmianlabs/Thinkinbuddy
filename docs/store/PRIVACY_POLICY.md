# ThinkinBuddy Privacy Policy — DRAFT

> **DRAFT — NOT LEGAL ADVICE, NOT YET IN EFFECT.**
> This is a plain-language working draft written from the app's actual
> data flows, for Troy and his counsel to review, complete, and
> approve before it is published. Every legal-specific slot is marked
> with [BRACKETS] and must be filled in before use. Do not publish
> this file as-is.

**Effective date:** [EFFECTIVE DATE]

**Who we are:** ThinkinBuddy is operated by [LEGAL ENTITY NAME],
[ENTITY ADDRESS] ("we", "us"). Questions about this policy or your
data: [PRIVACY CONTACT EMAIL]. [DPO NAME/ROLE, IF APPLICABLE]

---

## 1. What this policy covers

ThinkinBuddy is an AI companion app: you talk or type to a "buddy"
that remembers what you tell it, can create images and short videos,
and can set reminders. This policy explains what information the app
collects, why, who processes it for us, and the choices you have —
including how to delete everything.

## 2. Information we collect

**Account information.** Your email address and a password. Passwords
are stored only as a salted cryptographic hash (scrypt) — we cannot
read your password, and it is never stored or sent in plain text.

**Profile information.** The display name, age band, and "about me"
notes you (or a parent setting up the account) provide. The age band
is used to apply the right safety settings.

**Conversations.** The text of your chats, transcripts of voice
conversations, and the memories your buddy saves from them. This is
the core of the product: the buddy's memory lives in our database so
it can recall what you told it in later conversations.

**Voice audio.** When you use voice mode, your audio is sent to our
speech provider to be transcribed and answered. Voice conversations
produce stored text transcripts, like chats.

**Creations.** Prompts you give for images or videos, and the media
generated from them, which is stored so you can view it in the app.

**Safety settings.** Whether Safety Mode is on, and the parent PIN —
stored only as a salted cryptographic hash, never in plain text.

**Optional provider keys.** If you choose the Advanced option to use
your own AI-provider API keys, those keys are stored encrypted and
are used only to make calls to that provider on your behalf.

**Usage records.** Counts of how you use paid features (for example,
number of messages, voice characters, images, video seconds) so we
can meter your plan's monthly credit allowance fairly.

**Purchase information.** Your plan, subscription status, and billing
period, which we receive from our billing processor. Payments are
handled by Apple, Google, or Stripe through RevenueCat — **we never
see, receive, or store your card number.**

**Connected computers (Helmian Connect plan only).** If you pair a
computer, we store its label and pairing state so your buddy can
reach it through our relay. Actions on your computer require your
approval.

**What we do NOT collect:** your location, your contacts, your
browsing history, health data, or advertising identifiers. The app
contains no advertising and no third-party analytics or ad SDKs.

## 3. How we use information

Only to run the service: holding the conversation, remembering what
you told your buddy, generating replies and media, applying safety
settings and content moderation, metering your plan, processing your
subscription state, and keeping the service secure. We do not sell
your personal information. We do not use your information for
advertising, and we do not track you across other companies' apps or
websites.

## 4. Who processes information for us

Your content is processed by service providers only as needed to
answer you:

- **AI model providers** (OpenAI, Anthropic, and Google — the
  "brains" you can choose between) receive your chat text to generate
  replies.
- **ElevenLabs** receives voice audio for speech and voice replies.
- **OpenAI Moderation** receives chat input and generated replies for
  safety content checks.
- **Media generation providers** (Replicate, Runway, and HeyGen)
  receive your image/video prompts to create media.
- **RevenueCat** processes subscription purchases with Apple, Google,
  and Stripe, and tells us your plan state.
- **Hosting providers** (Vercel, for the app and media storage, and
  Neon, for the database) store and serve the service.

These providers process information on our behalf to provide the
service. We do not sell information to them or to anyone else.

## 5. Families and Safety Mode

The account holder creates the account, holds the password, and
controls Safety Mode. When Safety Mode is on, additional content
guardrails apply and turning it off requires the parent PIN when one
is set. Age bands in a profile are a parent's household setting used
to apply the right safety level — they are not shared with third
parties as advertising data. [COUNSEL TO REVIEW: this section must be
aligned with the final age-audience decision for the store listing —
kids-directed (COPPA) vs family/13+ with a parent account holder —
before publication.]

## 6. How long we keep information

Your account information, conversations, memories, and creations are
kept while your account exists, so your buddy can remember you. When
you delete your account (Section 7), that information is erased from
our service databases. Limited billing records — purchase event ids
and plan history, without conversation content — may be retained
after deletion where needed for accounting, tax, and dispute
purposes. [RETENTION PERIODS TO BE COMPLETED BY COUNSEL.]

## 7. Your choices and rights

- **Access and correction:** your profile is visible and editable in
  the app (Settings → Account & Safety).
- **Delete your account:** in the app at Settings → Account &
  Safety → Delete my account. Deletion requires your password and
  permanently erases your profile, memories, conversations, saved
  keys, paired computers, and credit grants. Deleting your account
  does **not** cancel a subscription — cancel it in the App Store,
  Play Store, or Stripe to stop billing.
- **Questions or requests** (including requests a parent makes about
  their child's information): [PRIVACY CONTACT EMAIL]. [ADD ANY
  JURISDICTION-SPECIFIC RIGHTS LANGUAGE — e.g. GDPR/CCPA — ON
  COUNSEL'S ADVICE.]

## 8. Security

Passwords and PINs are stored as salted hashes; provider keys you
supply are stored encrypted; traffic between the app and our
services is encrypted (HTTPS). No system is perfectly secure, but we
work to protect your information and limit access to it.

## 9. Changes to this policy

If we change this policy in a way that matters, we will update the
effective date above and [DESCRIBE NOTICE METHOD — e.g. notify
account holders by email / in-app notice] before the change takes
effect.

## 10. Contact

[LEGAL ENTITY NAME]
[ENTITY ADDRESS]
[PRIVACY CONTACT EMAIL]
