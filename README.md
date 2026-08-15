# pi-search-boost

**Search-boost extension for [pi](https://github.com/earendil-works/pi-coding-agent) — turns pi's web search into a multi-engine, research-grade capability: fused multi-engine retrieval, deep research loops, parallel subagents, focus-filtered page reading, caching, and full auditability.**

Built through 22 measured iterations against Grok Build / Claude Code / Codex as reference points. The behavior layer is guided by a proactive-search policy (the `<search_balance>` ruleset) injected into the system prompt, verified with real-world queries and audit-log evidence.

---

## Why

Default web search in coding agents is usually a single-engine black box: no cross-verification, no cost control, no observability, and models under-trigger (recalling stale facts) or over-trigger (searching for trivia). pi-search-boost fixes all of that:

- **Fused multi-engine search** — Bing (keyless) + Brave HTML (keyless) + Tavily + Exa + Brave in parallel; keyless mode always keeps two independent free channels (Bing + Brave HTML) for cross-checking
- **x-algorithm-inspired ranking** — score parameters centralized (x-algorithm `params.rs` style); per-domain **soft diversity decay** (each further hit from the same domain × 0.7 down to a 0.35 floor, hard cap 5) instead of a hard 2/domain cut — keeps long-tail results while stopping domain domination, deduplicated by URL, cross-ranked by engine agreement and domain quality. A result found by 2+ independent engines is high-confidence; single-engine noise is demoted.
- **Complexity routing** — search budget is bound to query complexity (Keiro / Adaptive-RAG pattern): `simple` = 1 variant × 2 engines (1 credit), `medium` = 2 × 3, `complex` = 3 × 4 + advanced extraction (2 credits). Simple lookups stop costing as much as deep research.
- **Focus-filtered page reading** — `fetch_page` with a `focus` parameter keeps only query-relevant paragraphs (Grok's find_in_page / Anthropic dynamic-filtering pattern). Measured: **95% token savings** (1136 words → 61).
- **Deep research loop** — search → fetch → extract → coverage check → follow-up queries → converge, with per-source corroboration (≥2 independent domains for key claims) and temporal freshness.
- **Parallel multi-agent research** — decompose a question into 2-4 subtasks; each runs as an independent pi subprocess (own context, own search budget); results are synthesized with cross-source verification.
- **Caching** — search results (6h) and pages (24h) persist to disk; hot cache hits are ~1ms, cross-process.
- **Audit & observability** — every search/fetch/research event is logged (JSONL, 5MB rotation) with tier, credits estimate, engine errors, timings. `/search-audit` and `/search-cache` commands in the TUI.
- **Proactive-search policy** — a `<search_balance>` ruleset injected before agent start: when to search by default (**any moment of doubt** — "I'm not sure / this could have changed" is the trigger, not a reason to guess; plus facts, versions, time-sensitive, comparisons, unfamiliar topics), when to skip (local code, pure writing, fundamental stable concepts), when to stop (evidence sufficient, same query twice = loop, ~3 rounds diminishing returns), autonomy rules (refine queries, curl fallback, direct URL fetching, prompt-injection guard), and **coding-time triggers** (search before writing code against an API you are unsure about: library docs, new dependency versions/alternatives, changed syntax, unrecognized errors, stack best practices).

---

## Deployment

**This is a pi extension — deploy it with pi.** pi auto-discovers extensions in `~/.pi/agent/extensions/`, so deploying means copying files there and letting pi load them. No build step, no bundler, no other agent framework required (and it will not work in Claude Code / Codex / etc. — the tools are registered through pi's extension API).

### Prerequisites

- **pi** installed: `https://github.com/earendil-works/pi-coding-agent` (any recent version)
- Node.js 20+ (or Bun) — pi's runtime
- Optional: Tavily / Exa / Brave API keys (keyless mode works without any)

### Step 1 — install the files (choose one)

**Option A: one-click installer (recommended)**

```bash
# Windows
install.bat

# macOS / Linux
chmod +x install.sh && ./install.sh
```

The installer copies the extension to `~/.pi/agent/extensions/search-boost/` and optionally registers your API keys.

**Option B: manual copy**

```bash
mkdir -p ~/.pi/agent/extensions/search-boost/lib
cp index.ts ~/.pi/agent/extensions/search-boost/
cp lib/*.ts ~/.pi/agent/extensions/search-boost/lib/
```

### Step 2 — load it in pi

Restart pi, or run `/reload` in the TUI. The four tools (`fused_search`, `fetch_page`, `deep_research`, `research_parallel`) and the two commands (`/search-cache`, `/search-audit`) become available automatically. The `<search_balance>` proactive-search policy is injected into the system prompt on agent start.

### Step 3 — verify the deployment

```bash
# quick smoke test (runs the extension directly, no install needed):
pi -ne -e ~/.pi/agent/extensions/search-boost/index.ts -p "fused_search 'tokio latest version'"

# in the TUI, both should respond:
/search-audit stats
/search-cache stats
```

If `/search-audit` shows events after a search, deployment is live.

### Uninstall

```bash
rm -rf ~/.pi/agent/extensions/search-boost
```

Then restart pi. Cache and audit files under `~/.pi/agent/` (`search-boost-cache.json`, `search-boost-audit.jsonl`) can also be removed.

### API keys (optional)

Without any keys, the extension still works in **keyless mode** (Bing HTML + Brave HTML + Jina Reader). For full power, set any of:

| Variable | Engine | Why |
| --- | --- | --- |
| `PI_SEARCH_TAVILY_KEY` | Tavily | Agent-designed search API; best quality (recommended). 1000 free credits/mo |
| `PI_SEARCH_EXA_KEY` | Exa | Semantic / neural search; complements keyword engines |
| `PI_SEARCH_BRAVE_KEY` | Brave | Keyword search with operators |
| `PI_SEARCH_CACHE_TTL` | — | Search cache TTL in seconds (default `21600`, 6h) |
| `PI_SEARCH_PAGE_TTL` | — | Page cache TTL in seconds (default `86400`, 24h) |

---

## Tools

| Tool | What it does |
| --- | --- |
| `fused_search` | Multi-engine search: keyword variants × engines in parallel → URL dedupe → cross-engine scoring → ranked hits with per-result engine provenance, publish dates, and full content (Tavily advanced / Exa) for direct consumption |
| `fetch_page` | Reader-mode fetch: Jina Reader (keyless) → local heuristic extractor fallback → headless-browser engine for thin pages. `focus` parameter filters to relevant paragraphs (80-95% token savings) |
| `deep_research` | Multi-round loop with coverage checking, per-source corroboration, primary-source hierarchy, and freshness. `mode=step` returns gaps + suggested queries for agent-driven iteration |
| `research_parallel` | 2-4 independent subagents (pi child processes) each with its own search budget, run in parallel, then synthesize with cross-source verification |

### fused_search parameters

| Parameter | Description |
| --- | --- |
| `query` | The question or topic |
| `queries` | Optional keyword variants (auto-derived if omitted) |
| `engines` | Subset: `bing`, `tavily`, `exa`, `brave` |
| `max_results` | Max fused results (1-20, default 10) |
| `include_domains` / `exclude_domains` | Hard client-side domain filters (engines ignore `site:` operators) |
| `recency` | `day`/`week`/`month`/`year` — half-life exponential decay for dated results |
| `min_score` | Drop results below a fused-score floor |
| `depth` | Tavily depth: `basic` (1 credit) / `advanced` (2 credits, query-aligned full extraction) |
| `complexity` | `auto`/`simple`/`medium`/`complex` — budget tier override |

Query style: write queries like Grok Build does — stack 3-6 domain keywords plus specific terms. `site:example.com` is auto-translated to a client-side include filter; `"a" OR "b"` auto-splits into parallel variants.

### TUI commands

- `/search-audit stats|recent|failures|domains|clear` — analyze the audit log: event counts, fetch success rates, engine errors, tier distribution, Tavily credit estimate, failing domains
- `/search-cache stats|clear` — inspect or clear the cache

---

## Architecture

```
index.ts        Tool registrations (fused_search, fetch_page, deep_research,
                research_parallel), TUI commands, <search_balance> ruleset injection
lib/engines.ts  Engine adapters (Bing HTML w/ redirect decoding + structure-change
                detection, Tavily, Exa, Brave), query preprocessing (site:/OR/quotes),
                complexity routing, cross-engine fusion scoring, recency decay
lib/extract.ts  Jina Reader + local heuristic extractor + headless-browser fallback,
                focus paragraph filtering (dynamic filtering), caching
lib/research.ts Deep research loop: rounds, coverage check, corroboration, follow-ups
lib/parallel.ts Subagent orchestration: spawns pi child processes (isolation, concurrency,
                timeouts, fault containment)
lib/cache.ts    TTL JSON cache persisted to disk (corrupt-file self-healing)
lib/audit.ts    JSONL audit log with 5MB rotation, tail-reading for /search-audit
lib/util.ts     fetch with timeout/signal, HTML decoding, URL normalization, CJK-aware
                tokenization, bounded concurrency pool
```

### Design sources (borrowed deliberately)

- **Jina Reader** (`r.jina.ai/<url>`, keyless markdown extraction) — same approach as [OpenDeepResearcher](https://github.com/mshumer/OpenDeepResearcher)
- **Tavily as default search API** — the [langchain-ai/open_deep_research](https://github.com/langchain-ai/open_deep_research) choice
- **Iterate-until-confident research loop** — OpenDeepResearcher's design, adapted to a tool-internal heuristic + `step` mode for LLM-driven iteration
- **Query decomposition + per-source citations** — [GPT-Researcher](https://docs.gptr.dev/blog/building-gpt-researcher) plan-and-solve pattern
- **Complexity routing** — Keiro / [Adaptive-RAG](https://arxiv.org/abs/2403.14403)
- **Dynamic filtering** — Grok's `find_in_page` / Anthropic dynamic-filtering pattern
- **Proactive-search stop rules** — WWW'26 evidence: search returns decay sharply after ~3 rounds (over-search is the dominant failure mode)

---

## Measured performance

| Metric | Value |
| --- | --- |
| Simple query (1 variant × 2 engines) | ~1.0s |
| Medium query (2 × 3) | ~3.2s |
| Complex query (3 × 4, advanced) | ~3.6s |
| Deep research round | 9.8s converged (2 rounds, source-cap) |
| Hot cache hit | 1-3ms |
| Focus filtering | 95% token savings (1136 → 61 words) |
| research_parallel (3 subtasks) | ~65s wall clock |
| Simple-query request reduction vs. flat search | -75% requests, ~half the credits |

### Verification approach

Every iteration was verified with real queries and audit-log evidence (not paper claims): engine failures are recorded per-engine with notes; tier/credits estimates are visible in `/search-audit stats`; cache hits are counted cross-process. Known failure modes (Bing challenge pages, Jina rate limits, DNS-polluted environments) are detected and degraded gracefully — and the autonomy ruleset tells the model to fall back to `curl` when tools fail.

---

## Known limitations

- **X/Twitter data**: not included (X API is paid; guest-token scraping is dead since 2025). Tavily/Exa indexes are the practical substitute.
- **Model-native triggering**: search triggering is policy-driven (system prompt), not RL-trained into the model. Empirically equivalent to model-decided triggering on the same model (all mainstream agents use model-decided tool use; none use server-side auto-triggering).
- **Bing HTML parsing**: depends on Bing's page structure; structure changes are detected and fail loudly (never silently empty results).
- **No self-hosted index**: retrieval is proxy via 4 engines; there is no local index of the web.

---

## Development history

23 measured iterations (in Chinese, see the repo commit history): from single-engine Bing scraping → 4-engine fusion with complexity routing → focus-filtered reading (95% token savings) → deep research with corroboration → parallel subagents → proactive-search policy (v3: anti-over-search stop rules; v4: autonomy/fallback rules) → final audit fixing parameter exposure bugs and tail-reading bugs → **round 23: TUN fake-ip carve-out (Clash TUN answers every DNS query with 198.18/15; the SSRF guard now allows an all-fake-ip hostname resolution while literal private IPs / loopback / metadata stay blocked; opt out with `PI_SEARCH_ALLOW_TUN_FAKEIP=0`) + single-policy merge (deduplicated the proactive-search ruleset into one `<search_balance>` with an explicit tool-routing section; the standalone web-search-guidance extension was retired).**
> Note for Clash/sing-box TUN users: without this fix, `fetch_page` / `web_fetch` fail on every real URL with "resolves to private IP 198.18.0.x". The bundled `web_fetch` from `@bytetrue/pi-web-search` has the same guard and needs the identical carve-out patched into `src/html.ts` (`assertPublicResolution`, opt out with `BYTE_PI_WEB_ALLOW_TUN_FAKEIP=0`) — note this is a node_modules patch that must be re-applied after `pi install` upgrades the package.

## Friends

- [Linux.do](https://linux.do/) — a friendly Chinese tech community

## License

MIT
