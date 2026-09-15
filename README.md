# Content Builder

Stateless content-generation service for the AI newsletter pipeline. Given a
newsletter's topics/voice, it runs four separate AI agents — **Research →
Curator → Writer → Reviewer** — and returns a structured **Issue** (JSON):
article summaries, a PM perspective on each, and a closing thought. It never
talks to subscribers, never sends email, and never stores newsletter data.

## How this fits the bigger picture

Content Builder is one of three cooperating services:

| Service | Role |
|---|---|
| **EmailServer** | System of record — newsletters, subscribers, templates, Issues, sending. |
| **Content Builder** (this repo) | Generates an Issue's content. Stateless. |
| **Conductor** | Orchestrates the schedule and the handoffs between the other two. Never waits on a human. |

The full design lives in [`docs/CONTENT-PIPELINE-ARCHITECTURE.md`](docs/CONTENT-PIPELINE-ARCHITECTURE.md).
The build plan (milestones, acceptance criteria) is in
[`docs/R2_BUILD-SPEC.md`](docs/R2_BUILD-SPEC.md) — canonical copy lives in
EmailServer's repo; this is a synced copy (see that file's own header note).

[`src/lib/issue-schema.ts`](src/lib/issue-schema.ts) is the wire contract this
service produces and EmailServer's ingestion endpoint accepts — a hand-kept
mirror, kept in sync by hand across both repos.

## Setup

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY and CONDUCTOR_ACCESS_SECRET
npm run dev
```

`GET /health` requires no auth. Every other route requires an
`x-conductor-secret` header matching `CONDUCTOR_ACCESS_SECRET`.

## Scripts

- `npm run dev` — run locally with hot reload (`tsx watch`)
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled build (`dist/index.js`)

## Status

Milestone 0 (scaffolding) — see `docs/R2_BUILD-SPEC.md` §8 for what's next.
