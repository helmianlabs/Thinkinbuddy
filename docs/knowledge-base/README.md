# ElevenLabs Knowledge Base — Structure Template

Exported from the live agent's Knowledge Base tab (2026-08-06). **The actual
document text is NOT included here** — only titles, sizes, and what each one
covers, so a new user can see the shape of the curriculum system and author
their own documents, or ask for the full text to be pulled into this repo as
a follow-up.

12 documents total, all `.md`/text type, all created by the account owner:

| Document | Size | Purpose |
|---|---|---|
| Sharp Minds Master v3.0 | 32.1 kB | Master framework — the umbrella doc all 8 curricula below plug into. |
| Finance Curriculum (Ages 6–Adult) | 9.5 kB | Age-scaled personal finance / money literacy lessons. |
| Critical Thinking & Logic Curriculum (Ages 6–Adult) | 8.8 kB | Reasoning, logic, and argument-evaluation lessons. |
| Coding, AI & Web Design Curriculum (Ages 6–Adult) | 10.9 kB | Programming, AI literacy, and web design fundamentals. |
| Leadership, Business & Organizational Psychology Curriculum (Ages 6–Adult) | 9.2 kB | Leadership, entrepreneurship, and org-behavior lessons. |
| Visual & Video Aid Prompts — Universal (All Curricula) | 8.6 kB | Shared prompt library the agent uses to generate supporting images/video for ANY of the 8 subject curricula. |
| Philosophy Curriculum (Ages 6–Adult) | 5.9 kB | Age-scaled philosophy / big-questions lessons. |
| Psychology & Social Psychology Curriculum (Ages 6–Adult) | 6.4 kB | Psychology and social-behavior lessons. |
| College Prep & Financial Aid Curriculum (Grade 7–Adult) | 10.1 kB | College admissions, applications, and financial aid guidance. |
| Academic Writing & English Curriculum (Grade 7–Adult) | 6.3 kB | Writing mechanics, structure, and English-language skills. |
| Daily_Brain_Dump_Protocol.md | 6.0 kB | Operating protocol for the "brain dump" conversational mode (capture → reflect → next steps). |
| Helmion | 118 B | Short pointer note referencing the optional desktop relay. |

## How this maps to the code

The repo's `lib/personality.js` only hardcodes **two** tutoring-mode system
prompts today (`spanish_tutor`, `feynman_module1` — see
`api/chat.js` `VALID_MODES`). The 8 subject curricula above live entirely in
ElevenLabs' hosted Knowledge Base, attached to the agent for retrieval —
there is no in-repo code path that lists or queries them (confirmed by
grep — no `knowledge_base` API calls exist in this codebase). To reproduce
this setup in a new account: create each document in your own Knowledge
Base tab with the same title, attach it to your agent, and enable RAG if you
want cost-efficient retrieval (the live account has RAG available but not
yet turned on — ElevenLabs estimated ~$0.37/min LLM cost savings).
