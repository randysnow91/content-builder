# Content Pipeline Architecture — Daily & Weekly Newsletter Automation

**Status:** Design document — **finalized, including the Reviewer's RAG
approach (2026-09-15).** Not yet a build spec (no milestones or acceptance
criteria); to be turned into an `R2_BUILD-SPEC.md` when build starts, using
§18's stages as the milestone list.

**Covers:** SRD R2 (Content Builder app, Conductor/orchestrator, scheduled
sends) and the R3 weekly-email + subscription-preference work, which the
pipeline pulls forward because a live weekly makes `subscription_preference`
real.

**Builds on:** `V1_BUILD-SPEC.md` (V1 complete, v1.8). EmailServer already
exists and is deployed.

| Version | Date | Summary |
|---------|------|---------|
| v0.1 | 2026-09-08 | Initial architecture from the design discussion. |
| v0.2 | 2026-09-10 | Finalized: all v0.1 open questions decided (§15). Added §16 (repository & infrastructure layout — 3 repos, 1 Supabase, 3 Render services) and §17 (running Claude Code per repo). Daily `send_after` pinned to 10:00 AM. |
| v0.3 | 2026-09-15 | Designed the Reviewer agent's three checks and its RAG system (§11): link validity and summary-accuracy are *not* RAG (mechanical / grounded-in-one-document), the PM-Perspective-vs-practices check *is* — a seed corpus in Content Builder's own `pgvector` Supabase project (a scoped exception to §16.2), growing later from a per-article `mailto:` feedback link. Added §18 (recommended build order — 5 stages, RAG lands at stage 3) and the R1-vs-R2 naming rationale in §19. |

---

## 1. Goal

Send a **daily** AI-news email (article cards, each with a PM perspective,
plus a closing thought) and a **weekly** email (a summary/roundup of the
week), with a **human review-and-approve step** before anything goes out.
Build it as **multiple cooperating agents with one orchestrator** — this is a
deliberate learning / portfolio goal, not only a functional one.

**Scale:** 1–2 users (the operator plus maybe one other newsletter owner).
Not a SaaS. No billing, signup, or org model — see §12.

---

## 2. The three services

| Service | New? | Owns | Runs as |
|---|---|---|---|
| **EmailServer** | exists (V1) | System of record: newsletters, subscribers, templates, **Issues**, send history, the review/approve lifecycle, rendering, sending. | Render web service |
| **Content Builder** | new (R2) | Generating an Issue's content: web search → curate → summarize → PM perspective → closing thought. **Stateless.** | Render service calling the Anthropic API (§11) |
| **Conductor** | new (R2) | Orchestration: the schedule, sequencing the pipeline, the service-to-service handoffs, failure handling. **Never waits on a human.** | Render cron / scheduled job |

### What each service does NOT do

- **EmailServer** does not generate content and does not know Content Builder
  exists. It exposes an endpoint to receive an Issue; it does not care whether
  the caller is the Conductor, a teammate's script, or a person.
- **Content Builder** does not talk to EmailServer, does not hold content
  history, does not know about subscribers or sending.
- **Conductor** does not generate content and does not render or send email. It
  calls the other two in order and passes data between them.

---

## 3. Core principles

1. **EmailServer is content-source-agnostic.** One endpoint: "here is an Issue
   for newsletter X." Anything can call it. This is what keeps EmailServer
   simple and is exactly what a future multi-tenant story needs.

2. **The Conductor is the only coordinator.** Content Builder and EmailServer
   never call each other. Conductor calls Content Builder, gets an Issue back,
   posts it to EmailServer. This is the orchestrator pattern and the part
   that's worth talking about on a resume.

3. **Content Builder is stateless.** "Generate for newsletter X" in, a
   structured Issue out. The Issue **history lives in EmailServer** (the Issue
   table). One source of truth; no cross-service sync.
   *(Revised from an earlier idea that Content Builder keep its own store —
   with the Issue model and 1–2 users, that's unnecessary.)*

4. **The human approval gate lives in EmailServer, not as a pause in the
   Conductor.** A scheduled job can't sit waiting for hours for a click. So the
   Conductor's last step is "create a draft Issue and trigger a notification,"
   then it exits. Approval happens later, in EmailServer's existing preview /
   send UI. "Pending approval" is a durable row, not a suspended process.

5. **Format experiments happen in Content Builder, not EmailServer.** EmailServer
   renders a fixed, small set of content **blocks** (§6). Content Builder
   decides which blocks, in what order, with what content. Changing the weekly
   format is a Content Builder change; EmailServer doesn't redeploy.

---

## 4. Data model changes to EmailServer

V1's model is "the `email_sections` rows *are* the email — Send sends whatever
is in them right now." There's no separation between the parts that never
change, today's content, and what actually went out last Tuesday. The pipeline
needs all three.

### 4.1 Template (the frame)

The stable parts of a newsletter: header, footer, about, the standing ad,
default styling. Roughly what `email_sections` becomes, but understood as "the
frame around the content." Edited by hand, rarely. One per newsletter.

### 4.2 Issue (the content) — new

One record per **newsletter × date × type**. The daily body or the weekly body.

- `type`: `daily` | `weekly`
- `status`: `draft` → `approved` → `sent` (or `skipped`)
- `send_after`: timestamp — the auto-send deadline (§9)
- `blocks`: the ordered content blocks (§6), as JSON
- `raw_html` (optional): an escape hatch — finished HTML that bypasses block
  rendering, for one-off experiments (§6.3)
- timestamps, who/what created it

The Conductor creates Issues as `draft`. The operator (or the auto-send
timer) moves them to `sent`. The Issue table **is** the generation history the
weekly reads from.

### 4.3 Send record (`send_history`) — enriched

On send, store the **composed HTML snapshot** — the exact bytes handed to
Mailgun. Immutable. This is "what subscribers actually received" (which can
differ from the Issue if the operator edited it before approving).

### 4.4 Subscription preference — finally used

`subscribers.subscription_preference` (`daily` | `weekly` | `both`) already
exists but is unused (everyone is `daily`; §4.4 of the build spec). The
pipeline makes it real — see §10.

---

## 5. Rendering: Template + Issue → email

At **preview and send time**, EmailServer composes:

```
Template (header, about, ad, footer)
  + Issue blocks rendered to HTML
  + the auto-added greeting ("Hi %recipient.name%,") and unsubscribe footer
  = the final email
```

The Issue is **never written into `email_sections.main_body`**. "Pull it into
the main body" happens here, at compose time. That's what allows staged drafts
and history.

---

## 6. The block model

### 6.1 An Issue is an ordered list of typed blocks

```json
{
  "type": "weekly",
  "date": "2026-09-12",
  "blocks": [
    {
      "kind": "text",
      "heading": "This week's throughline",
      "body": "Every big story this week was about **distribution**, not capability..."
    },
    {
      "kind": "article_card",
      "emoji": "🏥",
      "title": "ChatGPT Health Adds Epic Integration for Clinicians",
      "source": "TechCrunch",
      "copyright": "© 2026 TechCrunch",
      "summary": "OpenAI integrated ChatGPT Health directly into Epic's EHR system...",
      "pmPerspective": "This is a watershed moment for AI in enterprise software...",
      "url": "https://techcrunch.com/2026/09/01/chatgpt-health-adds-epic-integration/"
    },
    {
      "kind": "closing_thought",
      "heading": "💡 Useful Thought for Today",
      "body": "The companies winning right now aren't just building better AI..."
    }
  ]
}
```

### 6.2 EmailServer renders three block kinds

| Kind | Fields | Renders as |
|---|---|---|
| `article_card` | `emoji`, `title`, `source`, `copyright`, `summary`, `pmPerspective`, `url` | The `h3` + **Source** / **Summary** / **Why This Matters** / **Read full article** layout the Skill already produces |
| `text` | `heading?`, `body` (markdown) | A heading + a prose paragraph or two |
| `closing_thought` | `heading`, `body` | A visually distinct closing block |

Roughly three small render functions plus
`renderIssue(issue) = issue.blocks.map(renderBlock).join("")`.

With just these three kinds:

- **Daily** → `[article_card × N, closing_thought]`
- **Weekly "best of the week"** → `[article_card × 7, closing_thought]` (same shape)
- **Weekly "trends"** → `[text × 3, closing_thought]`
- **Weekly hybrid** → `[text (intro), article_card × 5, closing_thought]`

New block kinds get added only if a format genuinely needs one.

### 6.3 Escape hatch: `raw_html`

If an Issue has `raw_html`, EmailServer uses it verbatim instead of rendering
blocks. For trying something completely off-script for a single issue. Loses
the "restyle every issue from one template" benefit for that issue. Once a
format proves out with readers, formalize it as a block arrangement and drop
the raw HTML.

---

## 7. The daily pipeline

```
Conductor (scheduled, ~6:00 AM)
  │
  ├─▶ EmailServer:  GET newsletter config for X  (topics, voice, schedule)
  │
  ├─▶ Content Builder:  "generate a daily Issue for newsletter X"
  │       │  web search for recent, PM-relevant AI articles
  │       │  curate to the best 3–7, dedupe, relevance filter
  │       │  per article: summary + PM perspective
  │       │  write the closing thought
  │       ◀─ returns  { type: "daily", blocks: [...] }   (JSON, not HTML)
  │
  ├─▶ EmailServer:  POST Issue as draft   (status: draft, send_after: 10:00 AM)
  │       └─ EmailServer emails the operator a review link
  │
  └─ Conductor exits.  No waiting.

Operator (some time before 10:00 AM)         ── normal path
  └─▶ EmailServer: review (preview = Template + Issue)
        ├─ edit blocks if needed
        └─ Approve  ──▶ send ──▶ snapshot saved ──▶ Issue: sent

Auto-send cron (every ~15 min)               ── abnormal path
  └─ any Issue where status = draft AND send_after < now AND not skipped
        └─▶ send ──▶ snapshot ──▶ Issue: sent
```

Send filtering: subscribers with preference `daily` or `both` (§10).

---

## 8. The weekly pipeline

```
Conductor (scheduled, Friday ~2:00 PM)
  │
  ├─▶ EmailServer:  GET the week's sent daily Issues for newsletter X
  │                 (their send snapshots — what actually went out)
  │
  ├─▶ Content Builder:  "build a weekly Issue for X" + the week's content in the request body
  │       │  synthesize — format is Content Builder's call (best-of / trends / hybrid)
  │       │  Content Builder never calls EmailServer; the Conductor hands it the material
  │       ◀─ returns  { type: "weekly", blocks: [...] }
  │
  ├─▶ EmailServer:  POST Issue as draft   (status: draft — NO send_after; §9)
  │       └─ EmailServer emails the operator a review link
  │
  └─ Conductor exits.

Operator
  └─▶ review ──▶ Approve ──▶ send   (weekly is always manually approved)
```

Send filtering: subscribers with preference `weekly` or `both`.

**Friday:** a `both` subscriber receives the daily (AM) **and** the weekly
(PM). Two separate Issues, two sends, two approvals. No dedup or replace logic
— this is the intended behavior.

---

## 9. Human-in-the-loop & auto-send

- **Approval lives in EmailServer** (§3, principle 4). The operator reviews the
  composed preview and clicks Approve / Edit / Skip.
- **Notification:** when EmailServer receives a draft Issue, it emails the
  operator a review link. EmailServer already has Mailgun; the Conductor
  doesn't need to know how the operator is reached.
- **Auto-send applies to the daily only.** Issue is generated ~6:00 AM with
  `send_after` = **10:00 AM** — a ~4-hour review window. A cron check sends any
  `draft` past its `send_after` that isn't `skipped`. ("If it hasn't gone out
  by 10, send it.")
- **The weekly is always manually approved** — lower frequency, higher stakes,
  no `send_after`.
- **Guardrails:**
  - A broken or empty generation (no articles, empty blocks) is created
    **without** a `send_after` — it can't auto-send, it forces review.
  - An Issue carrying **unresolved Reviewer flags** (§11.5 — a bad link, a
    weak summary match, a practice-alignment concern) is treated the same way:
    no `send_after`, forces review. This only applies once the Reviewer exists
    (build stage 2+, §18).
  - Consider requiring the first N real daily sends be hand-approved before
    trusting auto-send.
  - The auto-send cron should log loudly and be easy to pause.

---

## 10. Subscription preferences & send filtering

| Send | Recipients |
|---|---|
| Daily Issue | `subscription_preference IN ('daily', 'both')` |
| Weekly Issue | `subscription_preference IN ('weekly', 'both')` |

- **No self-service preferences page needed to launch.** The admin subscriber
  **edit form already has a daily / weekly / both dropdown** (built in M1). At
  1–2 users the operator sets it by hand.
- The public `/preferences` page (build spec §4.4, R3) becomes worthwhile when
  the list is large enough that manual management is annoying. It reuses the
  `unsubscribe_token` mechanism from M5.
- The subscribe form could gain a daily/weekly/both choice at the same time.

---

## 11. Content Builder internals — the multi-agent shape

Content Builder is where the "multiple agents" learning goal is realised. Built
as a **service that calls the Anthropic API** (Messages API with the web-search
tool, or the Agent SDK) — not as a scheduled Claude Code skill. This is the
more portable resume story and gives full control over the pipeline.

**Decided:** the four agents below are **genuinely separate** — each its own
API call / context, coordinated by a small in-service orchestrator (not one
loop with tools). More moving parts, but it's the point of the exercise and
the better portfolio story.

| Agent | Job |
|---|---|
| **Research** | Given the newsletter's topic config, web-search for recent, relevant articles. Return candidates with source + URL. |
| **Curator** | Pick the best 3–7, dedupe, filter for genuine PM relevance, rank. |
| **Writer** | Per article: a tight summary and a PM perspective in the newsletter's voice. Write the closing thought. |
| **Reviewer** | Three checks on the draft (§11.1) — one of them genuine RAG (§11.2). |

The Conductor orchestrates *across services* (schedule, handoffs). Content
Builder orchestrates *within itself* (Research → Curator → Writer → Reviewer).

The existing Claude **Skill** is the proof of concept and the baseline for the
prompts — the daily Skill already produces the target card format, and the
weekly Skill shows one weekly format. Port the approach, don't run the Skill
in production.

### 11.1 The Reviewer's three checks — only one is RAG

Precision matters here (it's worth being able to draw this line in an
interview): "using retrieval" isn't all the same technique.

| Check | Technique | Needs a corpus / vector search? |
|---|---|---|
| **Link validity** — does the URL resolve to the actual article, not a 404, paywall redirect, or generic homepage? | Plain fetch + validation (e.g. does the fetched page's title/content match the expected article) | No — no retrieval at all. |
| **Summary accuracy** — does the summary/PM Perspective faithfully reflect the article? | Grounded verification: the Research agent already fetched the full article text; hand it to the Reviewer as context and ask "does this match?" | No — this is retrieval of *one already-known document*, not a search over a corpus. RAG-adjacent, not RAG. |
| **PM Perspective vs. PM practices** — does it reflect sound product-management thinking? | **Real RAG**: embed the PM Perspective, vector-search a corpus of practice documents, retrieve the top few, judge alignment against what was retrieved. | **Yes.** This is the one that's genuinely "query a knowledge base, generate grounded on retrieved context." |

### 11.2 The RAG corpus

- **Seed it small** — 10–30 short PM-practice documents to start (a paragraph
  or two each, e.g. "prioritize by user impact over technical elegance").
- **Storage:** Content Builder's **own** small Supabase project with
  `pgvector` enabled — separate from EmailServer's. This is a deliberate,
  scoped exception to "Content Builder has no database" (§3, principle 3):
  a knowledge base for the Reviewer's own tooling is not newsletter business
  data, so it doesn't belong in EmailServer, and Content Builder stays fully
  decoupled from EmailServer's schema.
- **Embedding provider:** turning text into the vectors that make similarity
  search possible needs a model *Claude doesn't provide* — Anthropic doesn't
  offer an embeddings API. Use a dedicated embedding provider: **Voyage AI**
  (Anthropic's recommended pairing) or OpenAI's embeddings are the standard
  choices. Decide at build time (stage 3, §18); needs its own API key either
  way.

### 11.3 Growing the corpus from feedback

Each email's article cards carry a **"Read full article · Disagree with this
take?"** pair of links (§11.4) — piggybacking the feedback prompt onto the
existing link line rather than adding a new one, so it costs no extra visual
weight.

- **V1 of the feedback loop (build now, stage 4):** the "Disagree?" link is a
  plain `mailto:` to the operator's own address, with the subject/body
  pre-filled with the article's identity (title, issue date) so the reader
  only has to type their reason. No new page, no new table, no new endpoint —
  replies just land in the operator's inbox for now.
- **V2 (later, not yet scoped):** the link instead posts to a small EmailServer
  page (same pattern as `/unsubscribe`) into a new `issue_feedback` table
  (issue id, article reference, reason, timestamp). Content Builder (via the
  Conductor) periodically pulls new feedback and embeds each one as its own
  document in the RAG corpus — *alongside*, not merged into, the seed
  practices. At review time the Reviewer retrieves both: the seed practices
  and similar past disagreements ("a reader raised this exact objection
  before"). EmailServer stays authoritative on the raw feedback; the vector
  store is a derived index, same pattern as pulling the week's Issues (§15,
  decision 2).
- **V3 (further out, not yet scoped):** periodically synthesize clusters of
  similar feedback into new distilled practice documents, rather than the
  corpus only ever growing by raw disagreements.

### 11.4 The feedback link

Per-article, not per-issue — the PM Perspective is per-article, so the
objection has to point at one specific card. Styled as a second small link
next to "Read full article", not a new line:

```
Read full article  ·  Disagree with this take?
```

### 11.5 What the Reviewer's findings do

**Annotate, don't block or loop — to start.** The Reviewer's findings (a bad
link, a weak summary match, a practice-alignment concern) attach to the draft
Issue and surface in the review email/preview; the human decides. A full
"Reviewer sends it back to the Writer to revise" loop is a reasonable future
enhancement (worth naming as "the natural next step" even before building it)
but adds real complexity — when to give up, cost, infinite-loop risk — not
needed to prove the concept.

One concrete effect now: an Issue with unresolved Reviewer flags can't
auto-send (§9's guardrails, extended).

---

## 12. Service-to-service auth

- The content-ingestion endpoint on EmailServer is protected by a
  **per-newsletter API key**, not the shared `ADMIN_ACCESS_SECRET`. A newsletter
  owner (or the Conductor acting for them) holds a key scoped to that one
  newsletter.
- The Conductor holds the key(s) and the Content Builder endpoint URL.
- Content Builder needs only its Anthropic API key and (if the Conductor
  passes the week's content rather than Content Builder fetching it) nothing
  from EmailServer at all.

---

## 13. Deployment shape

See §16 for the full repo + infrastructure layout. In brief:

- **EmailServer** — unchanged (Render web service; its existing Supabase project).
- **Content Builder** — a second Render web service, **free tier is fine** (only
  hit twice a day; a cold start doesn't matter for a job that runs for minutes).
  One endpoint. Calls the Anthropic API (generation) and, from build stage 3
  on, an embedding provider (Voyage AI or OpenAI, §11.2).
- **Conductor** — a Render **Cron Job** (Render's scheduled-job service type).
  Runs, does its handoffs, exits. No database.
- **No new Supabase project for newsletter data** — that all stays in
  EmailServer's existing database (plus the new `issues` table and template
  changes). **One scoped exception:** from build stage 3 on, Content Builder
  gets its **own** small Supabase project with `pgvector`, holding only the
  Reviewer's RAG corpus (§11.2) — not newsletter business data, so it doesn't
  belong in EmailServer.

---

## 14. Out of scope (for R2/R3)

- **SaaS mechanics** — billing, self-serve signup, organisations, tiers. A
  newsletter is provisioned by creating an `email_servers` row and issuing an
  API key.
- **Real delivery / bounce tracking** — the send still counts what Mailgun
  *accepted*. Bounce/delivered/complained tracking needs Mailgun webhooks
  (build spec §4.15, §11) — a separate piece of R3 work.
- **Per-user Content Builder** — Content Builder is the operator's tooling for
  the operator's newsletters. Other users import content by calling the
  ingestion endpoint from their own tools, or by composing in the UI.

---

## 15. Decisions (finalized 2026-09-10)

The v0.1 open questions, resolved:

1. **No-approval fallback** — the daily **auto-sends at 10:00 AM** if not
   already approved. ("If it hasn't gone out by 10, send it.") Generated
   ~6 AM → `send_after` 10 AM. Broken/empty generations still can't auto-send
   (§9). May revisit once auto-send has a track record.
2. **Week's content handoff** — the **Conductor** fetches the week's sent daily
   Issues from EmailServer and passes them to Content Builder in the request
   body. Content Builder never calls EmailServer.
3. **Newsletter generation config** (topics / voice / schedule) — **lives on
   EmailServer**, on or linked to the `email_servers` row. A newsletter's
   identity isn't split across services. The Conductor reads it when it starts
   a run.
4. **Content Builder's internal agents** — **genuinely separate agents**
   (Research / Curator / Writer / Editor), each its own API call/context,
   coordinated by a small in-service orchestrator. Deliberately the harder
   path — it's the learning goal (§11).
5. **Notification channel** — **email** from EmailServer to the operator, with
   a review link. Slack/push can come later.
6. **Weekly format** — **stays flexible.** The block model (§6) supports
   best-of / trends / hybrid without an EmailServer change. Decide by trying
   formats and getting reader feedback; each change is a Content Builder
   prompt/logic change only.

---

## 16. Repository & infrastructure layout

### 16.1 Three repos, one per service

Polyrepo, matching the three services 1:1. EmailServer already exists as a
clean standalone repo with per-milestone history; folding it into a monorepo
would mean rewriting that history for little benefit, and "three services over
HTTP APIs, deployed independently" is itself a representative distributed-
systems setup.

```
C:\Users\randy\Documents\development\SubscriberEmails\
  EmailServer\      → GitHub: email-server      (exists)
  ContentBuilder\   → GitHub: content-builder   (new)
  Conductor\        → GitHub: conductor         (new, small)
```

`SubscriberEmails/` stays a plain local folder — not a repo, not deployed.

*(Monorepo with shared packages is a fine thing to learn — but as a deliberate
separate exercise, not a retrofit here.)*

### 16.2 One Supabase project for newsletter data (plus one small exception)

EmailServer's existing Supabase project holds **all newsletter business
data** — newsletters, subscribers, templates, Issues, send history. Content
Builder and Conductor are **stateless with respect to that data**: no
newsletter-related database of their own, no duplicated Issue history.

- "Did today's run succeed?" is answered by "did a draft Issue appear in
  EmailServer by ~8 AM?" The Conductor checks this itself and emails the
  operator if not.

**Exception (build stage 3+):** Content Builder gets its own small Supabase
project (`pgvector` enabled) for the **Reviewer's RAG corpus** — see §11.2.
That's a knowledge base for Content Builder's own internal tooling, not
newsletter business data, so it's a deliberate exception to "one project,"
not a contradiction of it. EmailServer still never duplicates or depends on
it.

### 16.3 Render: three services

| Service | Render type | Cost |
|---|---|---|
| EmailServer | Web Service | exists |
| Content Builder | Web Service, **free tier** | $0 — only hit twice a day; cold start is irrelevant for a minutes-long job |
| Conductor | **Cron Job** | a few $/mo |

Incremental cost is small.

### 16.4 The shared contract (Issue / block schema)

This is the only thing that spans repos, so pin it:

- **EmailServer owns it** — defines the TypeScript types, does the rendering.
- **EmailServer validates every incoming Issue** at the ingestion endpoint
  (`zod` or similar). A Content Builder bug then yields a clear `400`, never a
  broken email.
- **Content Builder mirrors the type** — a hand-kept `src/lib/issue-schema.ts`
  (types + `zod` schema) copied into its repo. Upgrade path if that gets
  annoying: publish it as a tiny npm package, or `GET /api/schema/issue` from
  EmailServer. Start hand-kept.

### 16.5 Docs

The canonical design docs (`CONTENT-PIPELINE-ARCHITECTURE.md`, the future
`R2_BUILD-SPEC.md`) stay in **EmailServer's repo** — the anchor. Each new
repo's `README` links back to them, and a copy of the relevant doc + the
`issue-schema.ts` contract is placed in each new repo when it's scaffolded
(§17).

---

## 17. Running Claude Code on each service

**Launch Claude Code from the service's own folder** (`ContentBuilder/`,
`Conductor/`), not from the `SubscriberEmails/` parent:

- Git operations target the right repo; commits/branches/deploys are scoped
  correctly.
- The project's own `AGENTS.md` / `package.json` / deploy config is what gets
  picked up — no ambiguity from a non-repo parent containing sub-repos.
- Matches how EmailServer is already worked on.

**A localized session won't have the cross-repo context, so when a new service
is scaffolded, make the context travel with the repo:**

1. Copy `issue-schema.ts` (the §16.4 contract) into the repo.
2. Copy `CONTENT-PIPELINE-ARCHITECTURE.md` (and the future `R2_BUILD-SPEC.md`)
   into the repo's `docs/`.
3. Seed the repo's Claude memory at the start of the first session (operator
   profile, build workflow, a pointer to the architecture). A fresh memory
   namespace for a fresh project is correct.

**Launch from the parent only for deliberate cross-cutting changes** — e.g.
"change the Issue schema and update EmailServer *and* Content Builder in one
pass." That's the exception.

---

## 18. Recommended build order

Each stage ships something real and demoable before the next one starts —
the same "small, verifiable steps" discipline `V1_BUILD-SPEC.md` used for
EmailServer's M0–M7. This sequencing becomes the milestone list in
`R2_BUILD-SPEC.md`.

1. **Core pipeline.** Research → Curator → Writer only — no Reviewer yet.
   Conductor wires the result to EmailServer as a draft Issue; human reviews
   and sends (or auto-send at 10:00 AM, §9). This alone proves the multi-agent
   + orchestrator architecture and produces real daily emails.
2. **Reviewer — mechanical checks.** Link validity + summary accuracy against
   the source article (§11.1). No RAG, no database yet — pure value-add on
   top of stage 1.
3. **Reviewer — the RAG check.** The seed PM-practices corpus, `pgvector`,
   Content Builder's own Supabase project, an embedding provider, similarity
   search, the PM Perspective alignment judgment (§11.2). **This is the stage
   where "I built a system that uses RAG" becomes true** — before any
   feedback loop exists, so it's a complete, defensible RAG system on its own.
4. **Feedback loop.** The `mailto:` "Disagree with this take?" link (§11.3,
   §11.4) — capture only, no corpus integration yet.
5. **(Later, not yet scoped)** Wire feedback into the Reviewer's training:
   structured capture via an EmailServer page + `issue_feedback` table,
   syncing new feedback into the RAG corpus as its own documents alongside
   the seed practices (§11.3's "V2").

## 19. Relationship to the SRD and a future build spec

- SRD **R2** ("Content Automation & Scheduling"): this document is its detailed
  design. R2's "Content Builder app", "Conductor agent", "Scheduled sends",
  and "Message queuing" all map here.
- SRD **R3** ("Weekly & Subscriber Features"): the weekly email and the
  subscription-preference send filtering are designed here because a live
  weekly forces them. The self-service `/preferences` page and Mailgun-webhook
  engagement tracking remain later R3 work.
- **Why the future build spec is `R2_BUILD-SPEC.md`, not "V1" for Content
  Builder's own repo:** R1/R2/R3/R4 are phases of *this one product's*
  roadmap (defined in the SRD), not a per-repo version counter. EmailServer's
  V1 *was* R1 — R1 just isn't spelled out as a filename because it was the
  first release. Content Builder and Conductor are new *codebases*, but they
  exist to deliver R2 of the *same product* — so they inherit the R2 label
  rather than each starting their own "V1." One release ladder for the whole
  system means no translation needed when any repo's docs say "R2."
- Next step when build starts: turn this into `docs/R2_BUILD-SPEC.md` with
  milestones and acceptance criteria (§18's stages are the milestones), the
  same way `V1_BUILD-SPEC.md` was derived from the SRD. Canonical in
  EmailServer's repo (§16.5); copied into `content-builder/` and `conductor/`
  when each is scaffolded.

*End of Content Pipeline Architecture v0.3 — design finalized, RAG approach settled.*
