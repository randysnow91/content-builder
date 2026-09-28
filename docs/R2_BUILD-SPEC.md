# Claude Code Build Spec — Content Builder (R2)

**Status:** v1.6 — M0, M1, M2, and M3 complete (2026-09-28).
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
| v1.2 | 2026-09-16 | M2 built: the Reviewer agent (`src/agents/reviewer.ts`) runs link validity (`src/lib/linkCheck.ts`) and summary accuracy, wired as a 4th pipeline step. Deviated from the original wording (Reviewer fetches each URL itself rather than reusing "Research's already-fetched text," since Research never fetches full text — see M2's own design note). 3 of 4 acceptance criteria verified via targeted direct tests; the 4th (a full live run confirming zero flags on a clean generation) deferred to next session. |
| v1.3 | 2026-09-18 | M2 called done based on one successful live run plus fixes for a rate-limit misdiagnosis and a streaming/timeout issue. **This was premature** — see v1.4. |
| v1.4 | 2026-09-18 | M2 actually done. The v1.3 fix didn't hold: a fresh test hung past 1123 seconds despite a supposed 8-minute backstop. Root cause was architectural, not a number to tune: `web_search`'s `max_uses` is a hint, not a hard cap, and Research had no real ceiling on total search time. Rewrote `src/agents/research.ts` around a proven pattern from a separate, working job-search agent (reviewed read-only) — a real time-budget loop with `AbortSignal` tied to actual remaining time, extracting and accumulating results after every completed response (not just a final one), returning whatever's been found when the budget runs out. Deleted `src/lib/agentTurn.ts` (the streaming/mid-abort machinery from the reverted approach) - none of it survived into the actual fix. Also fixed a second real bug this surfaced: Curator's own JSON could get cut off on a larger candidate list (`max_tokens` raised); both Curator and Writer now degrade gracefully on failure, matching Research. Verified with three consecutive full, real pipeline runs, each completing in a bounded ~3 minutes and producing a valid newsletter with genuine Reviewer flags. |
| v1.5 | 2026-09-24 | M3 built: the Reviewer's third check, real RAG (architecture doc §11.1's "the stage where 'I built a system that uses RAG' becomes true"). Embedding provider: **Voyage AI** (`voyage-3`, 1024 dimensions). Storage: a new, separate Supabase project (`pgvector` enabled, RLS enabled with no policies since only the service_role key ever calls it). Seed corpus: 17 practice documents (within the spec's 10–30 range), authored from scratch and scoped tightly to what the Reviewer actually judges - a short PM Perspective on one news article - rather than drawn from general product-strategy material, after reviewing (but deliberately not copying from) two third-party copyrighted PM frameworks the user had on hand. One real bug found and fixed: the first version embedded each article's PM Perspective with its own Voyage API call: fine in testing, but Voyage's free tier (no payment method on file) rate-limits to 3 requests/minute, and a real newsletter has 5+ articles - fixed by batching all of a run's PM Perspectives into a single embeddings call, the same pattern the seed script already used. Verified against all four acceptance criteria: a direct test confirmed retrieval returns semantically relevant (not random) practices; a deliberately hype-y PM Perspective was flagged citing the specific practice it violated while a grounded one wasn't; and a live `POST /generate` run (real web search, 6 real articles) produced two genuine `practice_alignment` flags - each citing a specific retrieved practice - alongside a real `broken_link` and a real `inaccurate_summary` catch in the same run, confirming the three checks operate independently rather than as overlapping copies of each other. |
| v1.6 | 2026-09-28 | Content Builder deployed to Render for the first time (architecture doc §13 called for this; it hadn't actually happened yet - only planned). A real production test surfaced a second real M3 bug, the same class as M2's Curator/Writer issue: the practice check's `max_tokens: 2048` was enough for the 2-article local tests but too small once a real 5-article production run gave the model a genuinely large batch (each article's PM Perspective plus up to 4 retrieved practices) to judge - the model ran out of budget before emitting any text block, caught as "returned no text content to parse" rather than crashing the request (the try/catch added specifically for this check did its job). Raised to `4096`, matching Curator's own fix, and added `stop_reason` to the error message so a repeat wouldn't require re-deriving the cause from scratch. Reproduced the failure locally at the original 5-article scale before the fix, then confirmed it succeeds cleanly after - not just assumed fixed. |

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

### 4.3 Every pipeline stage degrades gracefully instead of erroring

**Decision:** if Research, Curator, or Writer fails for any reason,
`generateDaily.ts` catches it and falls back to a valid substitute rather
than a raw `500`: Research falls back to zero candidates, Curator falls
back to the raw uncurated candidates, Writer falls back to the
empty-articles path. Every failure is still logged loudly.

**Why:** decided 2026-09-18, directly from user feedback mid-debugging:
*"if the search is finding results but does not give them back to us
because it wants to keep looking... it should return what it finds no
matter what."* The primary fix for Research's own unpredictable duration
is now a real time-budget loop (M2's own notes, and the job-search
retrospective's principle: *"guarantees belong in enforced code, not in a
prompt the model can choose to skip"*) — the time budget itself is designed
to always return a real answer, so this fallback is now a rare backstop
for a genuine failure (an API error, a parsing failure), not the everyday
mechanism. An earlier attempt at a *different* kind of graceful degradation
— aborting a stream mid-flight and stitching partial state back together —
proved unsafe (the API rejects it under real conditions); this simpler,
boundary-level catch is what actually shipped.

**Trade-off:** a stage's failure now looks identical to "genuinely found
nothing/nothing worth keeping" from EmailServer's side. Given architecture
doc §9's guardrail (a broken/empty generation gets no `send_after`, forcing
human review either way), this distinction doesn't change what happens
next, so it wasn't worth preserving separately.

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

### M2: Reviewer — Mechanical Checks — ✅ done (2026-09-18)

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
      check — verified via a targeted direct test, and confirmed repeatedly
      in real full-pipeline runs (2026-09-18) where the Reviewer caught
      genuine broken/blocked links — `HTTP 403` (openai.com, Forbes),
      `HTTP 429` (VentureBeat) — with no prompting to look for that case.
- [x] A deliberately mismatched summary (edited after generation, re-run
      through just the Reviewer) is flagged by the accuracy check —
      verified directly with a synthetic false summary, and confirmed on a
      genuinely inaccurate real summary caught in a live run (below).
- [x] A clean generation produces no flags — verified at the Reviewer level
      directly, and in live runs where real, accurate articles were
      consistently left unflagged alongside the genuinely bad ones.
- [ ] *(Once EmailServer's ingestion accepts `reviewerFlags` — not required
      here)*: a flagged Issue posted to EmailServer gets `send_after = NULL`.

**This milestone was called "done" prematurely on 2026-09-18, then reopened
the same day** after a fresh test hung past 1123 seconds — nearly 19
minutes, far past the 8-minute timeout that was supposed to be the hard
backstop. That timeout not even firing was its own bug, not just bad luck,
and it correctly wasn't accepted as "probably fine." What follows is what
was actually wrong and how it actually got fixed - not a patched number,
a different architecture for Research entirely.

**The real root causes (2026-09-16 through 2026-09-18):**
1. The Anthropic SDK's default timeout (10 min) plus its default
   retry-on-timeout (2 retries) let a slow call hang far longer than
   expected before failing with no visibility into why.
2. `web_search`'s `max_uses` parameter turned out to be a hint, not an
   API-enforced hard cap - real runs used 9, then 17, then 30+ successful
   searches regardless of the value set, with no natural convergence point
   for some topic/day combinations.
3. A **non-streaming** call that runs long can hit a lower-level network
   idle timeout independent of the SDK's own `timeout` setting. Switching
   Research to streaming fixed that specific symptom and added real-time
   progress logging - a genuine improvement, but treating the *symptom*
   (a slow single call) rather than the actual shape of the problem
   (an open-ended search with no natural stopping point).
4. Tried aborting a stream mid-search once a tool-use count got too high,
   then forcing a final answer from partial results - reverted. The API
   rejects this: "When responding to programmatic tool calling, only
   tool_result blocks are allowed," since an abort can land while a server
   tool call is still in flight, with no reliable way to guarantee it lands
   cleanly between a tool call and its result. This was the point where
   tuning cap numbers against a moving target should have stopped, and
   didn't, right away.

**The actual fix - a proven pattern, not invented here:** `src/agents/research.ts`
was rewritten around the same architecture as a separate, working job-search
agent the user had already built and tested (`../job-search/lib/search.ts`,
reviewed read-only for this) — a **real time budget**, not a per-call
timeout guessed at from outside:

- Loop calling the API; each call's `AbortSignal` is tied to the *actual
  remaining* budget (e.g. a 3-minute total budget, shrinking each
  iteration), not a fixed constant.
- **Extract and accumulate candidates after every completed response**, not
  only a final one - the prompt explicitly asks the model to output
  partial JSON after each search batch, for exactly this reason.
- On timeout, just stop and return whatever's accumulated. No attempt to
  salvage a stream mid-flight (see point 4 above for why that's unsafe).
- `src/lib/agentTurn.ts` (the streaming/pause_turn/abort machinery from the
  abandoned approach) was deleted - none of it survived into the actual fix.

This directly reflects feedback from the user mid-debugging: *"if the
search is finding results but does not give them back to us because it
wants to keep looking... it should return what it finds no matter what."*
That framing - solve it with a real, code-enforced guarantee, not a bigger
number or a smarter prompt - is what actually worked. See
[the job-search retrospective](../job-search/docs/RETROSPECTIVE.md)'s own
lesson on this: *"guarantees belong in enforced code, not in a prompt the
model can choose to skip."*

**One more real bug found once Research could return more candidates than
before:** Curator's own JSON reply got cut off mid-string on a larger input
list (`max_tokens: 2048` wasn't enough). Raised to 4096; Writer's raised to
6144 as the same cheap insurance. Both agents also now degrade gracefully
if they fail for any reason (`generateDaily.ts`) - Curator falls back to
the raw uncurated candidates, Writer falls back to the empty-articles path -
rather than a raw error, matching Research's own fallback.

**Verified with three consecutive real, full-pipeline runs (2026-09-18)**,
each completing in a bounded, reasonable time (under 3.5 minutes total) and
each producing a valid, useful newsletter - not one lucky result.

---

### M3: Reviewer — the RAG Check — ✅ done (2026-09-24)

**Goals:** The PM-Perspective-vs-practices check is real, grounded RAG
(architecture doc §18, stage 3 — "the stage where 'I built a system that
uses RAG' becomes true").

**Design notes (decided while building):**
- **Embedding provider:** Voyage AI, `voyage-3` (1024 dimensions) - the
  `pm_practices.embedding` column and the `match_pm_practices` SQL function
  are both sized to match. If the model ever changes, both need updating
  together.
- **Corpus content:** the seed practices were authored from scratch, not
  copied from the two third-party PM framework documents reviewed for
  inspiration (a Pragmatic Institute ebook, a PMI Disciplined Agile poster) -
  both are `©`-marked marketing/course material, and most of their content
  (pricing, channels, launch logistics) doesn't apply to judging a
  one-paragraph PM take on a news article anyway. The 17 seed documents are
  scoped to five categories: customer/user grounding, distinguishing signal
  from hype, business/strategic relevance, risk/assumptions/tradeoffs, and
  actionability for a PM reader.
- **Retrieval mechanism:** PostgREST (Supabase's REST layer) can't do vector
  math through plain table queries, so retrieval goes through a Postgres
  function (`match_pm_practices`) called via `supabase-js`'s `.rpc()` -
  the standard pattern for pgvector + Supabase.
- **Database security:** RLS is enabled on `pm_practices` with zero
  policies. This has no effect on Content Builder's own code (it uses the
  service_role key, which bypasses RLS by design) but blocks the table from
  being publicly readable/writable via the anon key, which exists in the
  Supabase project regardless of whether anything currently uses it.
- **Failure handling:** the practice-alignment check is wrapped in its own
  try/catch inside `runReviewerAgent`, separate from the link/accuracy
  checks - a Voyage or Supabase outage drops that one check (logged loudly)
  rather than failing the whole Reviewer stage, consistent with §4.3's
  "degrade, don't error" principle.
- **Rate limits are a real constraint, not just a cost line item:** the
  first version called Voyage once per article. Voyage's free tier (no
  payment method on file) allows only 3 requests/minute, and a real
  newsletter run has 5+ articles - this would have broken on nearly every
  real run, not just under load. Fixed by batching all of a run's PM
  Perspectives into one embeddings call, matching the pattern the seed
  script (`src/scripts/seedPracticeCorpus.ts`) already used for the corpus
  itself.

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
- [x] The seed corpus is queryable — a similarity search against a sample
      PM Perspective returns relevant practice documents, not random ones.
      Verified directly: a hype-y test phrase ("this is a massive
      breakthrough that changes everything... adopt this immediately or get
      left behind") retrieved the "this changes everything framing" and
      "excitement ≠ evidence" practices as its top, most-similar matches.
- [x] The Reviewer's alignment judgment is visibly grounded in retrieved
      documents (log or surface which ones were retrieved) — not just an
      unsupported LLM opinion. `checkPracticeAlignment` logs each article's
      retrieved practices and similarity scores before judging, and flag
      messages cite the specific practice a perspective conflicts with.
- [x] A PM Perspective that clearly violates a seeded practice (test with a
      deliberately bad one) gets flagged; a sound one doesn't. Verified
      directly (a hype-y perspective flagged, a grounded one with an
      acknowledged risk and a named business implication wasn't) and
      confirmed in a live run: two genuine `practice_alignment` flags on
      real PM Perspectives, each citing the specific retrieved practice
      violated (an unlabeled adoption assumption; a sweeping "direction the
      whole market is heading" claim with no acknowledged risk), while the
      other four real perspectives in the same run weren't flagged.
- [x] This corpus/search lives entirely in Content Builder's own Supabase
      project — confirmed no dependency on or duplication into EmailServer's
      database. True by construction: a new, separate Supabase project, and
      nothing in `src/lib/ragCorpus.ts` or `supabaseClient.ts` references
      EmailServer's schema or database.

**Verified live (2026-09-24):** a real `POST /generate` run (live web
search, 6 real articles) produced all three Reviewer check types in a
single response - a real `broken_link` (HTTP 403 on a bot-blocking site), a
real `inaccurate_summary` (a summary claim not supported by the actual
article text), and two real `practice_alignment` flags - with one article
flagged by both the link check and the practice check independently,
demonstrating the three techniques catch genuinely different problems
rather than overlapping (architecture doc §11.1's whole point in
practice).

**Deployed and re-verified in production (2026-09-28):** Content Builder
was deployed to Render for the first time (architecture doc §13 - planned
since the design phase, but not actually done until now), with all six env
vars (including the three new M3 ones) added to the Render service
directly - separate from local `.env`. A real production run surfaced the
`max_tokens` bug documented in v1.6 above; after the fix, a second live
production run (6 real articles, larger than the run that originally
broke it) completed cleanly - confirmed via Render's own logs showing the
practice check retrieving practices for all 6 articles with no failure,
matching the 2 flags (`broken_link`, `inaccurate_summary`) actually present
in the response.

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

- **Embedding provider (M3):** decided as Voyage AI (`voyage-3`, 1024
  dimensions) once actually building the RAG check. Its free tier
  rate-limits to 3 requests/minute without a payment method on file - not a
  problem today (the Reviewer batches all of a run's embeddings into one
  call), but worth knowing if the corpus or call pattern grows.
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
- **Research's search behavior has no natural stopping point for some
  topics** - observed anywhere from 9 searches in under a minute to 30+
  still climbing after 5 minutes, for the same topics string on different
  runs. `web_search`'s `max_uses` doesn't reliably bound this (§M2). This is
  no longer a live problem in practice: Research runs on a fixed 3-minute
  wall-clock time budget (`src/agents/research.ts`) and returns whatever
  it's accumulated when that budget runs out, so total run time is bounded
  regardless of how much the model wants to keep searching. Worth
  revisiting only if 3 minutes ever proves too short for genuinely good
  results on a given day - the constant is easy to change, and nothing
  else assumes that specific value.

---

*End of Build Spec v1.6 — M0, M1, M2, and M3 complete, and deployed to
Render for the first time. M4 next.*
