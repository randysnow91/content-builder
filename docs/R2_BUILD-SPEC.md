# Claude Code Build Spec — Content Builder (R2)

**Status:** v1.2 — M0 and M1 complete; M2 code complete and mostly verified,
one live confirmation left (2026-09-16).
**Derived from:** `CONTENT-PIPELINE-ARCHITECTURE.md` (the cross-repo design —
read it first, especially §6, §11) + planning discussion (2026-09-15).
**Scope:** Content Builder's own R2 work only. EmailServer and Conductor each
have their **own** `R2_BUILD-SPEC.md` in their own repos — see the
architecture doc §16.5 for why this isn't one shared document (an earlier
version of this file tried that and caused real confusion — see the v1.0
note below).

| Version | Date | Summary |
|---------|------|---------|
| v1.0 | 2026-09-15 | Replaces the original cross-repo `R2_BUILD-SPEC.md`, which bundled EmailServer's and Conductor's milestones in here too. That followed an instruction in an earlier version of the architecture doc (§19) that, in practice, handed this repo a bigger document than what it's actually building, with no tooling keeping the EmailServer copy in sync. This version is scoped to Content Builder alone; M0's content and status carry over unchanged (it's already built). |
| v1.1 | 2026-09-16 | M1 built and verified: real `POST /generate` calls, live web search, all four acceptance criteria checked off (including the zero-articles fallback, verified via a targeted synthetic-input check rather than waiting on a real search to happen to find nothing). One real bug found and fixed along the way: long research turns can end with `stop_reason: "pause_turn"` instead of finishing — `src/lib/agentTurn.ts` now loops until a terminal stop reason. Noted a follow-up in §10: the agents currently hardcode "AI news" as the subject, not just as a default — a real second, non-AI newsletter would need that generalized, not copied. |
| v1.2 | 2026-09-16 | M2 built: the Reviewer agent (`src/agents/reviewer.ts`) runs link validity (`src/lib/linkCheck.ts`) and summary accuracy, wired as a 4th pipeline step. Deviated from the original wording (Reviewer fetches each URL itself rather than reusing "Research's already-fetched text," since Research never fetches full text — see M2's own design note). 3 of 4 acceptance criteria verified via targeted direct tests; the 4th (a full live run confirming zero flags on a clean generation) is blocked on an Anthropic-side web-search rate limit hit during testing, to finish next session. Two more real bugs found and fixed: the SDK's default timeout/retry settings could hang 10+ minutes before failing (tightened, then specifically loosened again for Research's own call once testing showed 3 minutes was too aggressive for genuine search work - see M2's known-issue note); and `extractJson()` didn't handle a model prefacing its JSON reply with explanatory prose. |

> **How to use this document.** The architecture doc says *what* and *why*,
> across all three services. This spec says *how, with what, and in what
> order* — for Content Builder specifically — the same relationship
> `V1_BUILD-SPEC.md` (in EmailServer's repo) has to the SRD. Work through the
> milestones (§8) one at a time, verifying each against its acceptance checks
> before moving on.
>
> **Implementation ownership.** Where this document shows route shapes or
> code snippets, treat them as one valid illustration of the intent, not a
> required implementation.
>
> **Cross-repo dependencies are pointers, not milestones owned here.** Where
> a milestone's *full* verification needs EmailServer or Conductor to exist
> (e.g. a true end-to-end test), that's called out explicitly — the milestone
> itself is still buildable and independently testable without them.

---

## 1. Build Instructions (ground rules for every session)

### 1.1 Explain Before Doing

Every session: explain what you're about to build and why before writing
code. If the approach changes from what's spec'd, explain why. Surface
constraints rather than working around them silently.

### 1.2 Stateless by default

Content Builder holds **no newsletter business data** — no Issue history, no
subscriber data, nothing that duplicates what EmailServer owns (architecture
doc §16.2, §3 principle 3). The **one** scoped exception is Content Builder's
own small `pgvector` project for the Reviewer's RAG corpus (M3) — that's
Content Builder's internal tooling knowledge, not newsletter business data.
If a milestone seems to need a new table outside that one case, stop and
flag it.

---

## 2. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Node + TypeScript, Express** (already scaffolded, M0) | No pages, ever — one JSON-in/JSON-out endpoint plus a health check. Next.js's routing/rendering machinery would be dead weight. |
| Validation | Hand-rolled type guards, mirroring `issue-schema.ts`'s own style | Matches EmailServer's existing convention (`isValidEmail`) — no dependency for a shape this small. |
| AI | **Anthropic Messages API** — the web-search tool for Research; four separate calls/contexts for the four agents (architecture doc §11) | A service calling the API directly, not a scheduled Skill. More portable resume story, full pipeline control. |
| Embeddings (M3 only) | **Voyage AI** (Anthropic's recommended pairing) or OpenAI embeddings — decide at M3 | Anthropic has no embeddings API (architecture doc §11.2); needed only once the RAG check is built. |
| RAG storage (M3 only) | Content Builder's **own** small Supabase project, `pgvector` enabled | Architecture doc §11.2/§16.2 — a scoped exception, not newsletter data. |

**Language:** TypeScript throughout, matching EmailServer.

---

## 3. Architecture at a Glance (Content Builder's slice)

Full picture: `CONTENT-PIPELINE-ARCHITECTURE.md` §7, §8, §11.

```
POST /generate   (gated by CONDUCTOR_ACCESS_SECRET, §4.1)
  │
  ├─▶ Research agent   — web search, candidate articles + source/direct URL
  ├─▶ Curator agent     — pick best 3–7, dedupe, rank for PM relevance
  ├─▶ Writer agent      — per-article summary + PM perspective; closing thought
  └─▶ Reviewer agent    — link validity, summary accuracy (M2), PM-practices RAG check (M3)
        ◀─ IssuePayload: { type, date, blocks: [...] }   (issue-schema.ts)
```

Content Builder never calls EmailServer. The Conductor calls Content Builder,
gets the `IssuePayload` back, and is the one that POSTs it onward.

---

## 4. Architecture Decisions Called Out

### 4.1 A shared-secret gate, not a per-newsletter key

**Decision:** `POST /generate` is protected by a single shared secret
(`CONDUCTOR_ACCESS_SECRET`), checked via header — the same pattern as
EmailServer's `ADMIN_ACCESS_SECRET`, not the per-newsletter API key scheme
EmailServer uses for its own ingestion endpoint (see EmailServer's own
`R2_BUILD-SPEC.md` §4.3).

**Why:** Every call to `/generate` costs real Anthropic API tokens (four
agent calls, plus an embedding call from M3). Content Builder is deployed at
a public Render URL. With zero protection, anyone who finds that URL can run
up the API bill. A single secret the Conductor holds is cheap insurance,
proportionate to the risk — there's exactly one legitimate caller, no
per-newsletter scoping need (Content Builder doesn't know which newsletter
it's serving beyond what's in the request body).

### 4.2 One `/generate` route, not two

**Decision:** A single `POST /generate` takes `{ type: "daily" | "weekly",
... }` rather than separate `/generate/daily` and `/generate/weekly` routes.

**Why:** The four-agent pipeline is the same shape either way (architecture
doc §7 vs §8) — only the Curator/Writer prompts and the presence of
`weekContent` differ. One route keeps the orchestrator in one place and
mirrors `issue-schema.ts`'s own `IssueType` discriminator.

---

## 5. Environment Variables

```bash
ANTHROPIC_API_KEY=your-api-key
CONDUCTOR_ACCESS_SECRET=choose-a-long-random-value   # §4.1
PORT=3000

# From M3 (Reviewer's RAG check):
EMBEDDING_PROVIDER_API_KEY=your-voyage-or-openai-key
CONTENT_BUILDER_SUPABASE_URL=https://your-cb-project.supabase.co
CONTENT_BUILDER_SUPABASE_SERVICE_KEY=your-service-key
```

### RAG storage schema (M3 only)

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

---

## 6. API Routes (Specification)

**GET /health**
- Returns `{ status: "ok" }`. No auth — Render health checks, a quick "is it
  up" from the Conductor. *(Built, M0.)*

**POST /generate** *(gated by `CONDUCTOR_ACCESS_SECRET`, §4.1)*
- Body: `{ type: "daily" | "weekly", newsletterConfig: { topics, voice }, weekContent?: IssuePayload[] }`
  (`weekContent` present only for `type: "weekly"` — the week's sent daily
  Issues, per architecture doc §8 and §15 decision 2)
- Returns: an `IssuePayload` (`issue-schema.ts`) — `{ type, date, blocks }`
  or `{ type, date, rawHtml }`
- Implementation: runs Research → Curator → Writer → (Reviewer, from M2) in
  sequence; a broken/empty generation still returns a *valid* payload (e.g.
  one `text` block explaining nothing was found), never an opaque 500

---

## 7. Key Implementation Notes

### 7.1 The four agents are genuinely separate calls

Per architecture doc §11 (decision 4, §15): Research, Curator, Writer, and
Reviewer are each their own Anthropic API call/context, coordinated by a
small in-service orchestrator function — not one agentic loop with tools
doing all four jobs. Deliberately the harder path; it's the point of the
exercise.

### 7.2 The Reviewer's three checks use three different techniques

Precision matters here (architecture doc §11.1) — don't implement all three
as "RAG":

| Check | Milestone | Technique |
|---|---|---|
| Link validity | M2 | Plain fetch + validation, no retrieval |
| Summary accuracy | M2 | Grounded verification against the Research agent's already-fetched article text — retrieval of one known document, not RAG |
| PM Perspective vs. practices | M3 | **Real RAG** — embed, vector-search the `pm_practices` corpus, judge alignment against retrieved context |

### 7.3 Reviewer findings annotate; they don't block or loop

Findings attach to the response (`reviewerFlags`, extending `issue-schema.ts`
if the wire contract needs a new field — update the copy in EmailServer too,
per §1.3's cross-repo exception in the architecture doc) and surface in
EmailServer's review UI. The human decides. No "send back to the Writer to
revise" loop in R2 — a reasonable future enhancement, not built now.

---

## 8. Milestones & Acceptance Criteria

### M0: Scaffolding & Setup — ✅ done (2026-09-15)

TypeScript + Express, the `CONDUCTOR_ACCESS_SECRET` gate on every route
except `/health`, `.env`/`.env.example`, `issue-schema.ts`, this repo's docs,
README. Kept here for the record; nothing left to do.

---

### M1: Core Pipeline (Research → Curator → Writer) — ✅ done (2026-09-16)

**Goals:** `POST /generate` produces a real daily `IssuePayload` from a live
web search — no Reviewer yet (architecture doc §18, stage 1).

**Tasks:**
1. Research agent: given `{ topics, voice }`, web-search (Anthropic's
   web-search tool) for recent, relevant articles; return candidates with
   source + **direct article URL**, not homepage links — the existing
   `ai-news-digest-pm` Skill's "extract direct article URLs" discipline is
   the baseline (`WorkingNotes/ai-news-digest-pm.md`).
2. Curator agent: pick the best 3–7, dedupe, filter for genuine relevance,
   rank.
3. Writer agent: per-article summary + PM perspective in the newsletter's
   voice; closing thought. Port the target format from the existing Skill
   (article-card fields, closing-thought style) — don't run the Skill itself
   in production.
4. Orchestrator function wiring the three calls in sequence, mapping the
   result into `article_card` + `closing_thought` blocks (`issue-schema.ts`).
5. Implement `POST /generate` for `type: "daily"` for real (replacing M0's
   stub); `type: "weekly"` can still be unimplemented for now (M5).
6. Handle the zero-articles case: return a valid, minimal payload rather than
   an empty/invalid one.

**Acceptance Criteria:**
- [x] `POST /generate { type: "daily", newsletterConfig }` returns a valid
      `IssuePayload` (passes `isValidIssuePayload()`) built from a live web
      search, not fixture data — verified via real Postman requests.
- [x] Every `article_card`'s `url` is a direct article link, not a homepage —
      verified against real search results.
- [x] A zero-articles run still returns a valid payload — verified by
      extracting the block-building logic into `buildDailyBlocks()`
      (pure, no API calls) and checking it against a synthetic empty
      `WriterOutput` with `isValidIssuePayload()`, since a real live search
      finding nothing isn't reliably reproducible on demand.
- [x] Each of the three agents is a separate, identifiable API call (visible
      in logs/tracing) — not one combined prompt. Verified via
      `[pipeline]` console logs showing each agent's input/output count
      (e.g. "Research found 3 candidate(s)" → "Curator kept 2 of 3" →
      "Writer produced 2 article(s)").
- [ ] *(Full end-to-end, once EmailServer's M1 exists — not required to pass
      this milestone on its own)*: manually posting the response to
      EmailServer's `POST /api/issues` produces a real, reviewable draft
      Issue.

---

### M2: Reviewer — Mechanical Checks — 🟡 code complete, final live confirmation pending (2026-09-16)

**Goals:** Link validity + summary accuracy checks run on every generation —
no RAG yet (architecture doc §18, stage 2).

**Design note (deviation from the original wording, decided 2026-09-16):**
this spec originally said to hand the Reviewer "the Research agent's
already-fetched article text" — but Research (M1) never fetches full text,
only web-search snippets. Rather than retrofitting Research, **the Reviewer
fetches each URL itself** (`src/lib/linkCheck.ts`): one fetch per article
answers the link-validity question *and* supplies the real page text the
accuracy check is grounded in. This is arguably more rigorous than the
original plan (checking against an independent fetch, not against Research's
own possibly-flawed notes).

**Tasks:**
1. Link validity check: fetch each `article_card.url`, verify it resolves to
   the actual article (not a 404, paywall redirect, or generic homepage) —
   plain fetch + validation, no retrieval (§7.2). Built: `src/lib/linkCheck.ts`.
2. Summary accuracy check: ask the Reviewer whether the summary/PM
   Perspective faithfully reflects the fetched article text. Built:
   `src/agents/reviewer.ts`.
3. Reviewer agent as a fourth, separate orchestrator step; findings collected
   into a `reviewerFlags` structure attached to the response. Built: added
   to `issue-schema.ts` and wired into `generateDaily.ts`.

**Acceptance Criteria:**
- [x] A deliberately broken URL (404) in a test run is flagged by the link
      check — verified directly against a real 404 URL (targeted check, same
      approach as M1's zero-articles verification, not a full live pipeline
      run).
- [x] A deliberately mismatched summary (edited after generation, re-run
      through just the Reviewer) is flagged by the accuracy check —
      verified directly: a real article's summary was replaced with a
      false one (claimed the page was about pizza history), and the
      Reviewer correctly flagged it with a specific explanation.
- [x] A clean generation produces no flags — verified at the Reviewer level
      directly (accurate summary → no flag, same targeted test as above).
      **Not yet reconfirmed through a full live Research → Curator → Writer
      → Reviewer run** — see the known issue below.
- [ ] *(Once EmailServer's ingestion accepts `reviewerFlags` — not required
      here)*: a flagged Issue posted to EmailServer gets `send_after = NULL`.

**Known issue found during testing, fixed:** the Anthropic SDK's default
timeout (10 min) and its default retry-on-timeout behavior (2 retries) meant
a slow call could silently hang far longer than expected before failing.
Tightened first (3 min, 1 retry) — but that was too aggressive in the other
direction: a real Research call doing genuine web searches can legitimately
take longer than 3 minutes and was being cut off before finishing. Settled
on a per-call override for Research specifically: 8-minute timeout, no
retries (`src/agents/research.ts`, via `runUntilDone`'s new `requestOptions`
parameter, `src/lib/agentTurn.ts`). Also hardened `extractJson()`
(`src/lib/json.ts`) to handle a model prefacing its JSON answer with
explanatory prose (seen when Research explained a search failure before
replying `[]`) instead of only handling a ```json fence.

**Open item for next session:** while testing this, Research began failing
with "Server tool use limit exceeded" on the web_search tool - an
Anthropic-side rate limit, almost certainly from the volume of test
generations run today. Need one more full, real `/generate` run (once the
limit clears) confirming a genuinely clean generation produces zero
`reviewerFlags`, to close out the last acceptance box with real evidence
rather than the isolated Reviewer-only test.

---

### M3: Reviewer — the RAG Check

**Goals:** The PM-Perspective-vs-practices check is real, grounded RAG
(architecture doc §18, stage 3 — "the stage where 'I built a system that
uses RAG' becomes true").

**Tasks:**
1. Choose the embedding provider (Voyage AI or OpenAI, §2) and get an API
   key.
2. Provision Content Builder's own Supabase project, `pgvector` enabled
   (§5).
3. Seed 10–30 short PM-practice documents into `pm_practices`.
4. Embed the PM Perspective, vector-search the corpus, retrieve the top few,
   judge alignment against what was retrieved.
5. Add this as the Reviewer's third check, alongside M2's two.

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

### M4: Feedback Loop (Capture Only)

**Goals:** Each article card carries a "Disagree with this take?" `mailto:`
link — capture only, no corpus integration yet (architecture doc §18, stage
4 / §11.3 "V1 of the feedback loop").

**Note:** the link itself renders inside EmailServer's HTML output, not
Content Builder's JSON — this milestone is mostly a small EmailServer-side
change (see that repo's `R2_BUILD-SPEC.md`), tracked here because it's the
feedback-loop feature.

**Tasks:**
1. (EmailServer side) Extend `article_card` rendering to add a second small
   link next to "Read full article" (architecture doc §11.4):
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

### M5: Weekly Synthesis

**Goals:** `type: "weekly"` in `/generate` does real synthesis of a week's
content (architecture doc §8).

**Tasks:**
1. Implement `type: "weekly"` for real (M1 left it unimplemented) — takes
   `weekContent: IssuePayload[]` (the week's sent dailies, fetched and
   passed in by the Conductor) and synthesizes a weekly `IssuePayload`.
2. Format (best-of-the-week / trends / hybrid) is Content Builder's own call
   and deliberately left flexible (architecture doc §15, decision 6) —
   decide by trying formats and reading feedback, not a one-time choice.

**Acceptance Criteria:**
- [ ] `POST /generate { type: "weekly", newsletterConfig, weekContent }`
      returns a valid `IssuePayload` synthesized from the given week's
      content, not a re-run of the daily pipeline.
- [ ] *(Full end-to-end, once the Conductor's weekly schedule and
      EmailServer's weekly send filtering both exist)*: a real Friday run
      produces a reviewable weekly draft built from that week's actual sent
      dailies.

---

## 9. Out of Scope (for this spec)

Same boundaries as the architecture doc §14, plus:

- EmailServer's and Conductor's own build work — see their own repos'
  `R2_BUILD-SPEC.md`.
- The Reviewer "sends it back to the Writer" revision loop (§7.3) — a
  reasonable future enhancement, not built here.
- V2/V3 of the feedback loop (structured capture into a table, syncing into
  the RAG corpus, synthesizing distilled practices from clusters of
  feedback) — architecture doc §11.3, explicitly "not yet scoped."

---

## 10. Known Limitations & Open Questions to Revisit

- **Embedding provider choice (M3)** is deliberately deferred — decide once
  actually building the RAG check, since pricing/API shapes may have moved.
- **Weekly format** stays flexible on purpose (architecture doc §15,
  decision 6) — M5's acceptance criteria don't pin down best-of vs. trends
  vs. hybrid.
- **The agents hardcode "AI news" as the subject**, not just as a default —
  `topics`/`voice` steer within that premise, they don't redefine it (raised
  2026-09-16 while discussing a hypothetical second, non-AI newsletter, e.g.
  "Dog Rescue"). A real second-domain newsletter would need a third config
  field (e.g. `subject`) threaded through the Research/Curator/Writer
  prompts, generalizing the one hardcoded assumption, rather than copying
  the agent files — the duplicate-prompts route lets bug fixes and
  improvements silently drift out of sync between copies. Not needed for
  M1 (one AI-focused newsletter); worth doing before a second, unrelated
  newsletter is ever actually added.

---

*End of Build Spec v1.2 — M0 and M1 complete; M2 code complete, one live confirmation left.*
