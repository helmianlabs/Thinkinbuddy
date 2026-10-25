# ThinkinBuddy

Your thinking buddy — a voice companion and tutor you talk to out loud.

ThinkinBuddy is a **hosted app by subscription**. Download it, sign up,
give your buddy a name and a couple of basics about you, and start
talking. There is nothing to configure: the backend, the API keys, and
the database are run for you by the service. No keys to collect, no
servers to set up.

*Status: being prepared for the App Store and Google Play. This
repository is the app's source code (see "For developers" below) — it is
not a self-host kit.*

## What your buddy does

- **Real conversation, out loud** — talk in real time; your buddy
  listens, answers, and knows when to stop talking. He remembers your
  past conversations, so he picks up where you left off instead of
  starting over every time.
- **Spanish, automatically** — start talking Spanish and your buddy
  answers in Spanish: conversation practice, translation help, or just
  chatting. No settings to change, no switch to flip.
- **Tutoring and explainer modes** — structured help that teaches
  instead of just answering, including explain-it-simply (Feynman) mode
  and Spanish tutoring. Ask him to teach you something step by step.
- **Can look things up** — web search and page reading in the middle of
  a conversation, so answers are not limited to what he already knows.
- **Media gallery** — pictures and clips from your conversations are
  kept in a gallery you can browse, search, and watch full-screen.
- **Parent safety mode** — a parent can turn safety mode on and lock
  it with a parent PIN; turning it off again requires the PIN. Hard
  guardrails sit underneath at all times.
- **Helmian Connect (top tier)** — connect your own PC and your buddy
  can carry out tasks on it for you, behind approvals: nothing
  consequential happens without a human yes, and what he does is
  recorded.

## Plans

Subscription tiers run from the basic buddy plan up to Helmian
Connect. Each paid tier includes a monthly usage allowance; heavier
extras, such as generated video, are covered by optional credit packs.
An advanced option lets power users plug in their own provider keys.
Pricing lives in the store listings.

## For developers

This repo holds the ThinkinBuddy source: a Vite web app wrapped with
Capacitor, with the native `ios/` and `android/` projects in-repo,
plus the backend (serverless API routes and a hosted Postgres
database) that the service operates. App id in code:
`com.helmianlabs.thinkinbuddy`.

The service's infrastructure, keys, and database are run by the
service and are not distributed with this repo. There are no
self-hosting instructions, because the product is the hosted app
described above.

## Repo history note

This repo was extracted (`git subtree split`) from a monorepo that also
contained an unrelated e-commerce storefront. History here starts from
that split — full original history remains in the source monorepo.
