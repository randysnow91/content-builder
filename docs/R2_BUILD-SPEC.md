# Claude Code Build Spec — Content Pipeline (R2)

**Status:** v1.0 — drafted, no milestones built yet.
**Derived from:** `CONTENT-PIPELINE-ARCHITECTURE.md` (the design document — read it
first) + planning discussion (2026-09-15).
**Audience:** Claude Code (the coding agent, run separately per repo — see §1.3)
+ the builder (product owner).
**Covers three repos:** `EmailServer/` (existing), `ContentBuilder/` (new),
`Conductor/` (new). One document, because R2 is one product delivery across
three codebases (architecture doc §19) — but each milestone belongs to one
repo, and is built in a Claude Code session launched from that repo's own
folder (§1.3).

| Version | Date | Summary |
|---------|------|---------|
| v1.0 | 2026-09-15 | Initial spec. M0–M7 scoped from the architecture doc's §18 build order plus the EmailServer/Conductor prerequisite work it depends on. No milestones built yet. |

> **How to use this document.**
> The architecture doc says *what* and *why*. This spec says *how, with what,
> and in what order* — the same relationship `V1_BUILD-SPEC.md` has to the SRD.
> Work through the **Milestones** (§8) one at a time, verifying each against
> its acceptance checks before moving on.
>
> **Implementation ownership.** Where this document shows schemas, route
> shapes, or code snippets, treat them as one valid illustration of the
> intent, not a required implementation. Claude Code owns final schema
> design, code structure, and technical approach, as long as the milestone's
> acceptance criteria are met.
>
> **Canonical copy.** This file lives in `EmailServer/docs/` (the anchor repo,
> per architecture doc §16.5). A copy — along with
> `CONTENT-PIPELINE-ARCHITECTURE.md` and `issue-schema.ts` — is placed in
> `ContentBuilder/docs/` and (when scaffolded) `Conductor/docs/`. When this
> spec changes, update the canonical copy first, then re-sync the others.

---

## 1. Build Instructions (ground rules for every session)

These apply to **every** milestone and Claude Code session. Reference them in
each prompt as "§1" rather than repeating.

### 1.1 Explain Before Doing

- **Every Claude Code session:** explain what you're about to build and why
  before writing code.
- If the approach changes from what's spec'd here, explain the change and why.
- If you hit a constraint or limitation, surface it and ask before working
  around it.

### 1.2 Stateless by default

- **EmailServer** is the only service allowed a database for newsletter
  business data (architecture doc §16.2). Content Builder and Conductor stay
  stateless with respect to that data — no newsletter/subscriber/Issue tables
  of their own. The one scoped exception is Content Builder's own small
  `pgvector` project for the Reviewer's RAG corpus (§11.2 of the architecture
  doc, M5 below) — that's Content Builder's internal tooling, not newsletter
  business data.
- If a milestone seems to need a new table outside those two cases, stop and
  flag it rather than adding one.

### 1.3 One repo, one session

- Launch Claude Code from the milestone's own repo folder (`EmailServer/`,
  `ContentBuilder/`, or `Conductor/`), not from the `SubscriberEmails/`
  parent — see architecture doc §17 for why (git scoping, correct
  `AGENTS.md`/config, no cross-repo ambiguity).
- When a new repo is scaffolded (M0 for Content Builder, the Conductor
  milestone below), copy in `issue-schema.ts`, this file, and the
  architecture doc, and seed that repo's own Claude memory (operator
  profile, build workflow, a pointer to the architecture doc) — a fresh
  memory namespace per project is correct.
- Launch from the parent only for a deliberate cross-cutting change (e.g.
  "change the Issue schema and update EmailServer *and* Content Builder in
  one pass").

---

## 2. Recommended Tech Stack (per repo)

Starting recommendations, not requirements — only the milestones and
acceptance criteria in §8 are binding.

| Repo | Layer | Choice | Why |
|---|---|---|---|
| **Content Builder** | Framework | **Node + TypeScript, Express** | No pages, ever — one JSON-in/JSON-out endpoint plus a health check. Next.js's routing/rendering machinery would be dead weight; Express is the leanest thing that gives clean route handlers, middleware (for the shared-secret gate, §4.1), and the same deploy shape (Render web service) EmailServer already uses. |
| **Content Builder** | Validation | Hand-rolled type guards (mirrors `issue-schema.ts`'s own style — see its header comment) | Matches the existing project convention (`isValidEmail` in EmailServer's `src/lib/validation.ts`) — no new dependency for a shape this small. |
| **Content Builder** | AI | **Anthropic Messages API** (web-search tool for Research; four separate calls/contexts for the four agents, §11) | Per architecture doc §11 — a service calling the API directly, not a scheduled Skill. More portable resume story, full pipeline control. |
| **Content Builder** | Embeddings (M5 only) | **Voyage AI** (Anthropic's recommended pairing) or OpenAI embeddings — decide at M5 | Anthropic has no embeddings API (architecture doc §11.2); needs a dedicated provider only once the RAG check is built. |
| **Content Builder** | RAG storage (M5 only) | Content Builder's **own** small Supabase project, `pgvector` enabled | Architecture doc §11.2/§16.2 — a scoped exception, not newsletter data. |
| **Conductor** | Framework | **Node + TypeScript, no web framework** | It's a script, not a server: run on a schedule, do the handoffs, exit (architecture doc §2, §13). Render **Cron Job**, not a web service. |
| **EmailServer** | — | **Unchanged** (Next.js App Router, Supabase, Mailgun) | New tables and one new route added to the existing app — see M1. |

**Language:** TypeScript throughout, matching EmailServer.

---

## 3. Architecture at a Glance

See `CONTENT-PIPELINE-ARCHITECTURE.md` §2–§11 for the full design. Condensed:

```
Conductor (scheduled, Render Cron Job)
  │
  ├─▶ EmailServer:      GET newsletter config (topics, voice, schedule)
  ├─▶ Content Builder:  POST /generate  { type, newsletterConfig, weekContent? }
  │       Research → Curator → Writer → Reviewer   (4 separate API calls, §11)
  │       ◀─ IssuePayload JSON (issue-schema.ts)
  ├─▶ EmailServer:      POST /api/issues  (draft Issue; per-newsletter API key)
  │       └─ EmailServer emails the operator a review link
  └─ exits — never waits on a human

Operator ──▶ EmailServer preview/approve/send UI (existing pattern, extended for Issues)
Auto-send cron (EmailServer, daily only) ──▶ sends anything past send_after, unless flagged
```

Content Builder's internal shape (architecture doc §11):

```
POST /generate
  │
  ├─▶ Research agent   — web search, candidate articles + source/URL
  ├─▶ Curator agent     — pick best 3–7, dedupe, rank for PM relevance
  ├─▶ Writer agent      — per-article summary + PM perspective; closing thought
  └─▶ Reviewer agent    — link validity, summary accuracy, PM-practices RAG check (M3–M5)
        ◀─ { type, date, blocks: [...] }
```

---

## 4. Architecture Decisions Called Out

### 4.1 Content Builder gets a shared-secret gate too

**Decision:** `POST /generate` is protected by a single shared secret
(`CONDUCTOR_ACCESS_SECRET`), checked via header, the same pattern as
EmailServer's `ADMIN_ACCESS_SECRET` (V1 spec §4.1) — not the per-newsletter
API key scheme from architecture doc §12 (that protects EmailServer's
ingestion endpoint, a different concern).

**Why:** Not in the architecture doc explicitly, but worth adding: every call
to `/generate` costs real Anthropic API tokens (four agent calls) and,
from M5, an embedding-provider call. Content Builder is deployed at a public
Render URL (architecture doc §13). With zero protection, anyone who finds
that URL can run up the API bill. A single secret the Conductor holds is
cheap insurance, proportionate to the risk (one caller, not a multi-tenant
auth problem).

**Trade-off:** Same as EmailServer's own gate (V1 spec §4.1) — not real
security against a determined attacker, fine for a single-operator service.

### 4.2 Content Builder's endpoint shape: one `/generate`, not two

**Decision:** A single `POST /generate` route takes `{ type: "daily" |
"weekly", ... }` rather than separate `/generate/daily` and
`/generate/weekly` routes.

**Why:** The four-agent pipeline is the same shape either way (architecture
doc §7 vs §8) — only the Curator/Writer prompts and the presence of
`weekContent` differ. One route keeps the orchestrator in one place and
mirrors `issue-schema.ts`'s own `IssueType` discriminator.

### 4.3 EmailServer's Issue ingestion validates with hand-rolled guards, not zod

**Decision:** `POST /api/issues` validates incoming payloads with
`isValidIssuePayload()` from `issue-schema.ts`, not a new `zod` dependency.

**Why:** The architecture doc (§16.4) floated "zod or similar," but
`issue-schema.ts` was already written hand-rolled, matching EmailServer's
existing `isValidEmail`-style convention (see the file's own header comment).
No reason to introduce a new dependency for a shape this size when the
existing style already covers it.

### 4.4 EmailServer's newsletter generation config: new columns, not a new table

**Decision:** Topics/voice/schedule (architecture doc §15, decision 3) are
added as JSON/text columns directly on `email_servers`, not a separate table.

**Why:** One newsletter has exactly one config; a join table would be
unjustified indirection for a 1:1 relationship. Revisit only if a newsletter
ever needs *versioned* config history.

---

## 5. Data Model & Environment Variables

### 5.1 EmailServer additions (M1)

```sql
-- New columns on email_servers: generation config + per-newsletter API key (§12, §15.3)
ALTER TABLE email_servers
  ADD COLUMN topics TEXT,              -- e.g. "AI product news, PM-relevant"
  ADD COLUMN voice TEXT,               -- tone/style guidance for the Writer agent
  ADD COLUMN content_api_key UUID DEFAULT gen_random_uuid();
  -- the Conductor authenticates POST /api/issues with this, scoped to one newsletter (§12)

-- Template: the stable frame (architecture doc §4.1) — starts as email_sections renamed/reused;
-- exact migration path (rename vs. new table) is Claude Code's call at M1.

-- Issues: one row per newsletter x date x type (architecture doc §4.2)
CREATE TABLE issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_server_id UUID NOT NULL REFERENCES email_servers(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('daily', 'weekly')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent', 'skipped')),
  send_after TIMESTAMP,          -- NULL = no auto-send (§9's guardrails)
  blocks JSONB,                  -- ordered content blocks (architecture doc §6); NULL if raw_html is set
  raw_html TEXT,                 -- escape hatch (§6.3)
  reviewer_flags JSONB,          -- unresolved Reviewer findings, if any (M3-M4); NULL = clean
  created_at TIMESTAMP DEFAULT NOW(),
  created_by TEXT                -- e.g. "conductor"
);
-- Indexes: email_server_id, status, send_after (for the auto-send cron query)

-- send_history: add the composed HTML snapshot (architecture doc §4.3)
ALTER TABLE send_history
  ADD COLUMN html_snapshot TEXT,   -- exact bytes handed to Mailgun; immutable
  ADD COLUMN issue_id UUID REFERENCES issues(id);
```

### 5.2 Content Builder — own Supabase project (M5 only)

```sql
-- pgvector-enabled project, separate from EmailServer's (architecture doc §11.2/§16.2)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE pm_practices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,          -- one PM-practice document, a paragraph or two
  embedding VECTOR(1536),         -- dimension depends on the chosen embedding model
  source TEXT DEFAULT 'seed',     -- 'seed' now; 'feedback' from the future V2 (architecture doc §11.3)
  created_at TIMESTAMP DEFAULT NOW()
);
-- Index: an ivfflat or hnsw index on embedding for similarity search
```

### 5.3 Environment Variables

```bash
# Content Builder (.env)
ANTHROPIC_API_KEY=your-api-key
CONDUCTOR_ACCESS_SECRET=choose-a-long-random-value   # §4.1
PORT=3000

# From M5 (Reviewer's RAG check):
EMBEDDING_PROVIDER_API_KEY=your-voyage-or-openai-key
CONTENT_BUILDER_SUPABASE_URL=https://your-cb-project.supabase.co
CONTENT_BUILDER_SUPABASE_SERVICE_KEY=your-service-key

# Conductor (.env)
EMAILSERVER_BASE_URL=https://your-email-server.onrender.com
CONTENT_BUILDER_BASE_URL=https://your-content-builder.onrender.com
CONDUCTOR_ACCESS_SECRET=same-value-as-content-builder
# Per-newsletter EmailServer API key(s) — §12; how these are stored (env var per
# newsletter, or fetched from EmailServer) is Claude Code's call at the Conductor milestone.

# EmailServer additions (existing .env.local, new values)
# (no new env vars — content_api_key values live in the database, §5.1)
```

---

## 6. API Routes (Specification)

Illustrative shapes — exact payloads may evolve during implementation as long
as the underlying capability is there.

### 6.1 Content Builder

**GET /health**
- Returns `{ status: "ok" }`. No auth — used for Render health checks and a
  quick "is it up" from the Conductor.

**POST /generate** *(gated by `CONDUCTOR_ACCESS_SECRET`, §4.1)*
- Body: `{ type: "daily" | "weekly", newsletterConfig: { topics, voice }, weekContent?: IssuePayload[] }`
  (`weekContent` present only for `type: "weekly"` — the week's sent daily
  Issues, per architecture doc §8 and §15 decision 2)
- Returns: an `IssuePayload` (`issue-schema.ts`) — `{ type, date, blocks }` or
  `{ type, date, rawHtml }`
- Implementation: runs Research → Curator → Writer → (Reviewer, from M3) in
  sequence; on a broken/empty generation, still returns a payload (empty
  `blocks` is invalid per `isValidIssuePayload`, so instead return the
  clearest safe fallback — Claude Code's call, but it must never throw an
  opaque 500 for "no articles found")

### 6.2 EmailServer additions

**GET /api/newsletters/:id/config** *(service-auth, §12)*
- Returns `{ topics, voice }` for the Conductor to pass to Content Builder

**GET /api/newsletters/:id/issues?type=daily&status=sent&since=...**
- Returns the week's sent daily Issues (send snapshots) for the weekly
  pipeline (architecture doc §8) — Conductor fetches, passes to Content
  Builder as `weekContent`

**POST /api/issues** *(protected by the newsletter's `content_api_key`, §12)*
- Body: an `IssuePayload`, validated with `isValidIssuePayload()` (§4.3)
- Creates a `draft` Issue row; `send_after` set to +4h only for `type:
  "daily"` **and** an empty `reviewer_flags` (§9's guardrails) — `weekly`
  and any flagged Issue get `send_after = NULL`
- Triggers the existing operator-notification email with a review link
- Returns: `{ id, status, send_after }`
- A `400` on an invalid payload — never a broken email (§16.4)

*(Preview/approve/send UI changes needed to actually review an Issue in
EmailServer's admin are scoped inside M1 below, not spelled out route-by-route
here — extend the existing Builder/Send pages rather than inventing new ones.)*

### 6.3 Conductor

No inbound API — it's a scheduled script, not a server. Its "interface" is
the calls it makes outward (§6.1, §6.2) on a Render Cron Job schedule.

---

## 7. Key Implementation Notes

### 7.1 The four Content Builder agents are genuinely separate calls

Per architecture doc §11 (decision 4, §15): Research, Curator, Writer, and
Reviewer are each their own Anthropic API call/context, coordinated by a
small in-service orchestrator function — not one agentic loop with tools
doing all four jobs. This is deliberately the harder path; it's the point of
the exercise (multi-agent architecture as a portfolio story).

### 7.2 The Reviewer's three checks use three different techniques

Precision matters here (architecture doc §11.1) — don't implement all three
as "RAG":

| Check | M | Technique |
|---|---|---|
| Link validity | M3 | Plain fetch + validation, no retrieval |
| Summary accuracy | M3 | Grounded verification against the Research agent's already-fetched article text — retrieval of one known document, not RAG |
| PM Perspective vs. practices | M4 | **Real RAG** — embed, vector-search the `pm_practices` corpus, judge alignment against retrieved context |

### 7.3 Reviewer findings annotate; they don't block or loop

Findings attach to the Issue (`reviewer_flags`) and surface in the review
UI — the human decides (architecture doc §11.5). The one automatic effect:
an Issue with unresolved flags can't get a `send_after` (§9's guardrails).
No "send back to the Writer" loop in R2 — flagged as a reasonable future
enhancement, not built now.

### 7.4 Service-to-service auth is two different mechanisms, on purpose

- Content Builder's `/generate` — one shared secret (§4.1), because there's
  exactly one legitimate caller (the Conductor) and no per-newsletter
  scoping need (Content Builder doesn't know which newsletter it's serving
  beyond what's in the request body).
- EmailServer's `/api/issues` — a per-newsletter key (architecture doc §12),
  because EmailServer hosts multiple newsletters and a leaked key should
  only compromise one of them.

Don't conflate the two into one auth scheme.

---

## 8. Milestones & Acceptance Criteria

### M0: Content Builder — Scaffolding & Setup

**Repo:** `ContentBuilder/` (this session).

**Goals:** GitHub repo, Node/TypeScript/Express scaffolding, shared-secret
gate, local dev ready, health check live.

**Tasks:**
1. Create GitHub repo (`content-builder`).
2. Initialize a TypeScript + Express project (`npm init`, `tsc`, `express`,
   `@anthropic-ai/sdk`, `dotenv`; dev deps `typescript`, `tsx`/`ts-node-dev`,
   `@types/*`).
3. Create `.env` (git-ignored) with `ANTHROPIC_API_KEY` and
   `CONDUCTOR_ACCESS_SECRET` placeholders; commit a `.env.example`.
4. Add middleware enforcing `CONDUCTOR_ACCESS_SECRET` on every route except
   `/health` (§4.1) — constant-time comparison, mirroring EmailServer's
   `adminAuth.ts` approach.
5. Add `GET /health` (no auth).
6. Copy `issue-schema.ts` into `src/lib/`, `CONTENT-PIPELINE-ARCHITECTURE.md`
   and this file into `docs/` (§1.3, architecture doc §17).
7. Write a `README.md`: what this service is, how it fits the three-service
   architecture, setup/run instructions.
8. Verify local dev (`npm run dev`), `/health` responds, `/generate` (a stub
   returning `501 Not Implemented` is fine at this stage) rejects requests
   missing the secret and accepts requests with it.

**Acceptance Criteria:**
- [ ] Repo exists on GitHub with a clean initial commit.
- [ ] `npm run dev` starts the server without errors.
- [ ] `GET /health` returns `200 { status: "ok" }` with no auth required.
- [ ] Any other route rejects requests without `CONDUCTOR_ACCESS_SECRET` and
      allows them with the correct value.
- [ ] `.env` is in `.gitignore`; `.env.example` is committed with placeholder
      values only.
- [ ] `issue-schema.ts`, the architecture doc, and this build spec are present
      under `docs/`/`src/lib/` in this repo.
- [ ] README explains the service's role and how to run it locally.

---

### M1: EmailServer — Issue/Template Data Model + Ingestion Endpoint

**Repo:** `EmailServer/` (separate session, launched from that folder).

**Goals:** EmailServer can receive and store an Issue, and the operator can
review/approve/send it, before Content Builder or Conductor exist to
produce one for real (test with a hand-crafted payload).

**Tasks:**
1. Migration: `issues` table, `email_servers` additions (`topics`, `voice`,
   `content_api_key`), `send_history` additions (§5.1).
2. `POST /api/issues` (§6.2) — validated with `isValidIssuePayload()` (§4.3),
   per-newsletter `content_api_key` auth, sets `send_after` per §9's
   guardrails, triggers the existing operator-notification email.
3. `GET /api/newsletters/:id/config` and `GET /api/newsletters/:id/issues`
   (§6.2) — for the future Conductor to call.
4. Extend the admin UI: a way to preview/approve/send an Issue (compose
   Template + Issue per architecture doc §5) — reuse as much of the existing
   Builder/Send UI pattern as fits rather than inventing a parallel one.
5. Extend the auto-send cron (existing pattern) to also pick up `draft`
   Issues past `send_after` (architecture doc §9).
6. Test end-to-end with a hand-crafted `IssuePayload` posted via `curl`/
   Postman — no Content Builder needed yet.

**Acceptance Criteria:**
- [ ] `POST /api/issues` accepts a valid payload, rejects an invalid one with
      a `400` (never a broken email).
- [ ] A posted daily Issue with no Reviewer flags gets `send_after` = +4h; a
      weekly Issue, or one with flags, gets `send_after = NULL`.
- [ ] The operator receives a review-link email when a draft Issue is created.
- [ ] The operator can preview (Template + Issue composed), edit, approve,
      and send an Issue from the admin UI.
- [ ] On send, the composed HTML snapshot is saved to `send_history`.
- [ ] The auto-send cron sends any `draft` daily Issue past its `send_after`.
- [ ] `content_api_key` correctly scopes `POST /api/issues` to one newsletter
      — a key for newsletter A cannot create an Issue for newsletter B.

---

### M2: Content Builder — Core Pipeline (Research → Curator → Writer)

**Repo:** `ContentBuilder/`.

**Goals:** `POST /generate` produces a real daily `IssuePayload` from a live
web search — no Reviewer yet (architecture doc §18, stage 1).

**Tasks:**
1. Research agent: given `{ topics, voice }`, web-search (Anthropic's
   web-search tool) for recent, relevant articles; return candidates with
   source + direct article URL (not homepage links — the existing Skill's
   §4 "Extract Direct Article URLs" discipline is the baseline).
2. Curator agent: pick the best 3–7, dedupe, filter for genuine relevance,
   rank.
3. Writer agent: per-article summary + PM perspective in the newsletter's
   voice; closing thought. Port the target format from the existing
   `ai-news-digest-pm` Skill (article-card fields, closing-thought style) —
   don't run the Skill itself in production.
4. Orchestrator function wiring the three calls in sequence, mapping the
   result into `article_card` + `closing_thought` blocks (`issue-schema.ts`).
5. Implement `POST /generate` for `type: "daily"` for real (replacing M0's
   stub); `type: "weekly"` can still 501 for now.
6. Handle the zero-articles case: return a valid, minimal payload (e.g. one
   `text` block explaining nothing was found + a closing thought) rather
   than an empty/invalid one.

**Acceptance Criteria:**
- [ ] `POST /generate { type: "daily", newsletterConfig }` returns a valid
      `IssuePayload` (passes `isValidIssuePayload()`) built from a live web
      search, not fixture data.
- [ ] Every `article_card`'s `url` is a direct article link, not a homepage.
- [ ] Manually posting the response to EmailServer's `POST /api/issues` (M1)
      produces a real, reviewable draft Issue end-to-end.
- [ ] A zero-articles run still returns a valid payload.
- [ ] Each of the three agents is a separate, identifiable API call (visible
      in logs/tracing) — not one combined prompt.

---

### M3: Conductor — Scaffold + Daily Orchestration

**Repo:** `Conductor/` (new — scaffold this milestone).

**Goals:** The full daily pipeline runs end-to-end on a schedule, with no
human in the loop until the review step (architecture doc §7).

**Tasks:**
1. Scaffold the repo: Node + TypeScript, no framework, `.env`, README, copy
   in the architecture doc + this build spec (§1.3).
2. Write the orchestration script: `GET` newsletter config from EmailServer
   → `POST /generate` to Content Builder → `POST /api/issues` to EmailServer
   → exit. Log loudly at each step.
3. Handle failure at any step without a partial/corrupt Issue — if Content
   Builder or EmailServer errors, log and exit; never invent a fallback
   Issue.
4. Deploy as a Render Cron Job, scheduled ~6:00 AM (architecture doc §7).
5. Verify: "did a draft Issue appear in EmailServer by ~8 AM?" is answerable
   by checking EmailServer directly (architecture doc §16.2) — no Conductor
   database needed.

**Acceptance Criteria:**
- [ ] Running the script locally (pointed at both live services) produces a
      real draft daily Issue in EmailServer, starting from nothing.
- [ ] Deployed as a Render Cron Job; a scheduled run produces the same result
      without manual triggering.
- [ ] A deliberately-broken Content Builder call (e.g. wrong secret) fails
      loudly in logs and does not create a bad Issue.
- [ ] No database, no persisted state in Conductor.

---

### M4: Content Builder — Reviewer, Mechanical Checks

**Repo:** `ContentBuilder/`.

**Goals:** Link validity + summary accuracy checks run on every generation —
no RAG yet (architecture doc §18, stage 2).

**Tasks:**
1. Link validity check: fetch each `article_card.url`, verify it resolves to
   the actual article (not a 404, paywall redirect, or generic homepage) —
   plain fetch + validation, no retrieval (§7.2).
2. Summary accuracy check: hand the Research agent's already-fetched article
   text to the Reviewer as context; ask whether the summary/PM Perspective
   faithfully reflects it.
3. Reviewer agent as a fourth, separate orchestrator step; findings collected
   into a `reviewerFlags` structure attached to the response (extend
   `issue-schema.ts` if the wire contract needs a field for this — update
   the copy in EmailServer too, §1.3's cross-repo exception).
4. Wire `reviewerFlags` through to EmailServer's `reviewer_flags` column
   (M1) so a flagged Issue can't get a `send_after` (§9's guardrails,
   architecture doc §11.5).

**Acceptance Criteria:**
- [ ] A deliberately broken URL (404) in a test run is flagged by the link
      check.
- [ ] A deliberately mismatched summary (edited after generation, re-run
      through just the Reviewer) is flagged by the accuracy check.
- [ ] A clean generation produces no flags.
- [ ] A flagged Issue posted to EmailServer gets `send_after = NULL`
      regardless of `type`.
- [ ] Findings are visible in EmailServer's review UI, not just in logs.

---

### M5: Content Builder — Reviewer, the RAG Check

**Repo:** `ContentBuilder/`.

**Goals:** The PM-Perspective-vs-practices check is real, grounded RAG
(architecture doc §18, stage 3 — "the stage where 'I built a system that
uses RAG' becomes true").

**Tasks:**
1. Choose the embedding provider (Voyage AI or OpenAI, §2) and get an API
   key.
2. Provision Content Builder's own Supabase project, `pgvector` enabled
   (§5.2).
3. Seed 10–30 short PM-practice documents into `pm_practices`.
4. Embed the PM Perspective, vector-search the corpus, retrieve the top few,
   judge alignment against what was retrieved.
5. Add this as the Reviewer's third check, alongside M4's two.

**Acceptance Criteria:**
- [ ] The seed corpus is queryable — a similarity search against a sample
      PM Perspective returns relevant practice documents, not random ones.
- [ ] The Reviewer's alignment judgment is visibly grounded in retrieved
      documents (log or surface which ones were retrieved) — not just an
      unsupported LLM opinion.
- [ ] A PM Perspective that clearly violates a seeded practice (test with a
      deliberately bad one) gets flagged; a sound one doesn't.
- [ ] This corpus/search lives entirely in Content Builder's own Supabase
      project — confirmed no dependency on or duplication into EmailServer's
      database.

---

### M6: Content Builder — Feedback Loop (Capture Only)

**Repo:** `ContentBuilder/` (prompt/Writer changes) + `EmailServer/` (the
rendered link — small, can ride along in this milestone or be a short
EmailServer-side follow-up).

**Goals:** Each article card carries a "Disagree with this take?" `mailto:`
link — capture only, no corpus integration yet (architecture doc §18, stage
4 / §11.3 "V1 of the feedback loop").

**Tasks:**
1. Extend the `article_card` rendering (EmailServer side) to add a second
   small link next to "Read full article" (architecture doc §11.4):
   `Read full article · Disagree with this take?`
2. The `mailto:` link's subject/body is pre-filled with the article's
   identity (title, issue date) so the reader only types their reason.
3. No new page, table, or endpoint — replies land in the operator's own
   inbox.

**Acceptance Criteria:**
- [ ] Every sent daily/weekly email's article cards show both links.
- [ ] Clicking "Disagree with this take?" opens a pre-filled email to the
      operator's address with the article's title and issue date already
      in the subject/body.
- [ ] No new EmailServer table or route was added for this milestone.

---

### M7: Weekly Pipeline + Subscription Preferences Go Live

**Repo:** `Conductor/` (new schedule) + `ContentBuilder/` (weekly synthesis)
+ `EmailServer/` (send filtering — mostly already built, V1 M1).

**Goals:** A real weekly email goes out, built from the week's sent dailies,
to subscribers who actually asked for it (architecture doc §8, §10).

**Tasks:**
1. Conductor: a second scheduled job (Friday ~2:00 PM) — `GET` the week's
   sent daily Issues from EmailServer, `POST /generate { type: "weekly",
   weekContent }` to Content Builder, `POST /api/issues` (no `send_after` —
   always manual approval) to EmailServer.
2. Content Builder: implement `type: "weekly"` in `/generate` for real
   (M2 left this as a 501 stub) — synthesize the week's content; format
   (best-of / trends / hybrid) is Content Builder's own call (architecture
   doc §6.2).
3. EmailServer: confirm send filtering already respects
   `subscription_preference` (`daily`/`weekly`/`both`) for both Issue types
   — the column and admin edit-form dropdown already exist (V1 M1); this
   milestone is verification, not new UI, unless a gap is found.
4. Verify the Friday both-subscriber case: two separate Issues, two sends,
   two approvals, no dedup (architecture doc §8) — intended behavior, not a
   bug to fix.

**Acceptance Criteria:**
- [ ] The Friday Conductor run produces a real weekly draft Issue in
      EmailServer, built from that week's actual sent dailies.
- [ ] The weekly Issue never gets a `send_after` — always requires manual
      approval.
- [ ] Sending the weekly reaches only `weekly`/`both` subscribers; the daily
      reaches only `daily`/`both` — verified with at least one subscriber
      in each preference bucket.
- [ ] A `both` subscriber on a Friday receives both emails as separate sends.

---

## 9. Getting Started (First Session — M0)

1. **Accounts needed:**
   - GitHub (repo) — already authenticated via `gh` CLI.
   - Anthropic (API key) — for Content Builder's four agents.
   - Render (deployment) — can defer until M0's code exists.
   - Voyage AI or OpenAI (embeddings) — deferred to M5.
   - A second Supabase project (RAG corpus) — deferred to M5.

2. **M0 Setup** (this session, from `ContentBuilder/`):
   - Create the GitHub repo.
   - Scaffold Node + TypeScript + Express.
   - Add the shared-secret middleware and `/health` route.
   - Copy in `issue-schema.ts`, the architecture doc, and this build spec.
   - Commit, verify locally.

3. **Commit discipline:**
   - Commit after each major task, same convention as EmailServer:
     `"M0: Project scaffolding"`, `"M0: Add shared-secret gate"`, etc.
   - Tag milestone completion clearly so the build story reads cleanly later.

---

## 10. Out of Scope (for this spec)

Same boundaries as the architecture doc §14:

- SaaS mechanics (billing, self-serve signup, org model).
- Real delivery/bounce tracking (Mailgun webhooks) — separate R3 work.
- Per-user Content Builder — this is the operator's own tooling.
- The Reviewer "sends it back to the Writer" revision loop (§11.5) — named
  as a future enhancement, not built here.
- V2/V3 of the feedback loop (structured capture into a table, syncing into
  the RAG corpus, synthesizing distilled practices from clusters of
  feedback) — architecture doc §11.3, explicitly "not yet scoped."
- The public self-service `/preferences` page — stays R3, not needed until
  the subscriber list is large enough that manual management is annoying
  (architecture doc §10).

---

## 11. Known Limitations & Open Questions to Revisit

- **Auto-send trust.** The daily auto-sends at +4h if not reviewed. Consider
  requiring the first N real sends be hand-approved before trusting this
  (architecture doc §9) — not enforced in code, just an operating discipline
  to remember.
- **Embedding provider choice (M5)** is deliberately deferred — decide once
  you're actually building the RAG check, not now, since pricing/API
  shapes may have moved.
- **Weekly format** stays flexible on purpose (architecture doc §15,
  decision 6) — M7's acceptance criteria don't pin down best-of vs. trends
  vs. hybrid; that's an ongoing product decision made by trying formats.
- **Newsletter generation config UI.** M1 adds `topics`/`voice` columns but
  doesn't require a polished admin UI to edit them — a direct DB edit or a
  minimal form is fine until it's annoying.

---

*End of Build Spec v1.0 — drafted, no milestones built.*
