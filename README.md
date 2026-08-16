# pi-search-boost

**Search-boost extension for [pi](https://github.com/earendil-works/pi-coding-agent) — turns pi's web search into a multi-engine, research-grade capability: fused multi-engine retrieval, deep research loops, parallel subagents, focus-filtered page reading, caching, and full auditability.**

The behavior layer is guided by a proactive-search policy (the `<search_balance>` ruleset) injected into the system prompt on agent start.

---

## What you get

- **Fused multi-engine search** — Bing (keyless) + Brave HTML (keyless) + Tavily + Exa + Brave in parallel; keyless mode always keeps two independent free channels (Bing + Brave HTML) for cross-checking
- **Cross-engine ranking** — deduplicated by URL, cross-ranked by engine agreement and domain quality, with per-domain soft diversity decay; a result found by 2+ independent engines is high-confidence, single-engine noise is demoted
- **Complexity routing** — search budget bound to query complexity: `simple` = 1 variant × 2 engines (1 credit), `medium` = 2 × 3, `complex` = 3 × 4 + advanced extraction (2 credits)
- **Focus-filtered page reading** — `fetch_page` with a `focus` parameter keeps only query-relevant paragraphs (measured ~95% token savings)
- **Deep research loop** — search → fetch → extract → coverage check → follow-up queries → converge, with per-source corroboration (≥2 independent domains for key claims)
- **Parallel multi-agent research** — decompose a question into 2-4 subtasks, each run as an independent pi subprocess with its own search budget
- **Caching** — search results (6h) and pages (24h) persist to disk; hot cache hits are ~1ms, cross-process
- **Audit & observability** — every search/fetch/research event logged (JSONL, 5MB rotation) with tier, credits estimate, engine errors, timings; `/search-audit` and `/search-cache` commands in the TUI
- **Proactive-search policy** — a `<search_balance>` ruleset injected before agent start: when to search by default (any moment of doubt), when to skip, when to stop (~3 rounds diminishing returns), autonomy/fallback rules, and coding-time triggers (search before writing code against an API you are unsure about)

---

## Install — let pi do it

**Prerequisites:** pi installed (v0.84 or newer recommended; the extension uses `pi.registerTool` and the `before_agent_start` system-prompt injection). No build step, no bundler.

### Option A: one-command install from git (recommended)

No clone needed — pi clones the repo, registers it in `~/.pi/agent/settings.json`, and loads it as a package.

```bash
# 1. Try it first without installing (runs once from a temp dir):
pi -e git:github.com/Mr-remon219/pi-search-boost -p "fused_search 'tokio latest version'"

# 2. Install:
pi install git:github.com/Mr-remon219/pi-search-boost
```

Then restart pi or run `/reload`.

### Option B: clone, then install locally

```bash
git clone https://github.com/Mr-remon219/pi-search-boost.git
cd pi-search-boost
pi install .
```

### Option C: manual copy (fallback — no pi package mechanism)

```bash
# Windows
install.bat
# macOS / Linux
chmod +x install.sh && ./install.sh
```

Copies the extension to `~/.pi/agent/extensions/search-boost/` (pi auto-discovers extensions there).

### Have pi finish the setup for you

Once installed, paste this into a pi session — the agent reads this README and does the rest:

> Read this README and complete the setup for me: confirm the extension loaded (search-audit stats), install the optional companion package `@bytetrue/pi-web-search` so I also get `web_search` / `web_fetch`, walk me through API keys (or configure the ones I paste), and run the verification steps.

### Optional companion: `web_search` / `web_fetch`

This package provides `fused_search`, `fetch_page`, `deep_research`, and `research_parallel`. The lighter `web_search` / `web_fetch` tools are **not part of this repo** — they come from the separate pi package [`@bytetrue/pi-web-search`](https://www.npmjs.com/package/@bytetrue/pi-web-search), which the policy's tool-routing section references for quick single-point lookups. Install it to get the same complete toolset:

```bash
pi install npm:@bytetrue/pi-web-search
```

> TUN note: if you run Clash/sing-box in TUN mode, `web_fetch` needs the same fake-ip carve-out patched into its `src/html.ts` (`BYTE_PI_WEB_ALLOW_TUN_FAKEIP=0` to disable) — a node_modules patch that must be re-applied after the package is upgraded. See the note under [Known limitations](#known-limitations).

---

## API keys (optional — keyless mode works without any)

Keys are **environment variables** (the extension does not read `.env` files):
- Windows: `setx PI_SEARCH_TAVILY_KEY "..."` — the extension also reads `HKCU\Environment` directly, so `setx` takes effect without restarting processes
- macOS / Linux: `export PI_SEARCH_TAVILY_KEY="..."` (or add to your shell profile)
- Or run `install.bat` / `install.sh` and enter keys interactively

| Variable | Engine | Why |
| --- | --- | --- |
| `PI_SEARCH_TAVILY_KEY` | Tavily | Agent-designed search API; best quality (recommended). 1000 free credits/mo |
| `PI_SEARCH_EXA_KEY` | Exa | Semantic / neural search; complements keyword engines |
| `PI_SEARCH_BRAVE_KEY` | Brave | Keyword search with operators |
| `PI_SEARCH_CACHE_TTL` | — | Search cache TTL in seconds (default `21600`, 6h) |
| `PI_SEARCH_PAGE_TTL` | — | Page cache TTL in seconds (default `86400`, 24h) |
| `PI_SEARCH_ALLOW_TUN_FAKEIP` | — | Set to `0` to disable the Clash/sing-box TUN fake-ip carve-out (default enabled) |

Key registration: [Tavily](https://tavily.com) (1000 free credits/mo) · [Exa](https://exa.ai) · [Brave](https://brave.com/search/api/)

---

## Verify

After install (and after any search), these should respond:

```
/search-audit stats    # event counts, engine errors, tier distribution, credit estimate
/search-cache stats    # cache hits / entries
```

Quick smoke test (runs the extension directly, no install needed):

```bash
pi -ne -e git:github.com/Mr-remon219/pi-search-boost -p "fused_search 'tokio latest version'"
```

---

## Update / uninstall

```bash
# Move the pinned git ref and reconcile the checkout:
pi install git:github.com/Mr-remon219/pi-search-boost@main

# Uninstall:
pi remove git:github.com/Mr-remon219/pi-search-boost
```

Manual installs: update by re-running `install.bat`/`install.sh`; uninstall with `rm -rf ~/.pi/agent/extensions/search-boost`.

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
| `engines` | Subset: `bing` (keyless), `bravehtml` (keyless), `tavily`, `exa`, `brave` |
| `max_results` | Max fused results (1-20, default 10) |
| `include_domains` / `exclude_domains` | Hard client-side domain filters (engines ignore `site:` operators) |
| `recency` | `day`/`week`/`month`/`year` — half-life exponential decay for dated results |
| `min_score` | Drop results below a fused-score floor |
| `depth` | Tavily depth: `basic` (1 credit) / `advanced` (2 credits, query-aligned full extraction) |
| `complexity` | `auto`/`simple`/`medium`/`complex` — budget tier override |

Query style: stack 3-6 domain keywords plus specific terms (Grok Build style). `site:example.com` is auto-translated to a client-side include filter; `"a" OR "b"` auto-splits into parallel variants.

The optional companion package `@bytetrue/pi-web-search` adds `web_search` (single-engine lookup) and `web_fetch` (raw page fetch).

### TUI commands

- `/search-audit stats|recent|failures|domains|clear` — analyze the audit log: event counts, fetch success rates, engine errors, tier distribution, Tavily credit estimate, failing domains
- `/search-cache stats|clear` — inspect or clear the cache

---

## Architecture

```
index.ts        Tool registrations (fused_search, fetch_page, deep_research,
                research_parallel), TUI commands, <search_balance> ruleset injection
lib/engines.ts  Engine adapters (Bing HTML w/ redirect decoding + structure-change
                detection, Tavily, Exa, Brave, Brave HTML), query preprocessing
                (site:/OR/quotes), complexity routing, cross-engine fusion scoring,
                recency decay
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

---

## Known limitations

- **X/Twitter data**: not included (X API is paid; guest-token scraping is dead since 2025). Tavily/Exa indexes are the practical substitute.
- **Model-native triggering**: search triggering is policy-driven (system prompt), not RL-trained into the model.
- **Bing HTML parsing**: depends on Bing's page structure; structure changes are detected and fail loudly (never silently empty results).
- **No self-hosted index**: retrieval is proxied via 4 engines; there is no local index of the web.
- **Free channels are rate-limited**: the keyless Brave HTML channel can return 429 under IP-level rate limiting; failures are audited and the engine is skipped (never silently empty).

---

## Development history

23 measured iterations (see the repo commit history): from single-engine Bing scraping → 4-engine fusion with complexity routing → focus-filtered reading (95% token savings) → deep research with corroboration → parallel subagents → proactive-search policy (v3: anti-over-search stop rules; v4: autonomy/fallback rules) → audit fixes → **round 23: TUN fake-ip carve-out (Clash TUN answers every DNS query with 198.18/15; the SSRF guard now allows an all-fake-ip hostname resolution while literal private IPs / loopback / metadata stay blocked; opt out with `PI_SEARCH_ALLOW_TUN_FAKEIP=0`) + single-policy merge (deduplicated the proactive-search ruleset into one `<search_balance>` with an explicit tool-routing section; the standalone web-search-guidance extension was retired).**
> Note for Clash/sing-box TUN users: without this fix, `fetch_page` fails on every real URL with "resolves to private IP 198.18.0.x". If you also use the `@bytetrue/pi-web-search` package, its bundled `web_fetch` has the same guard and needs the identical carve-out patched into `src/html.ts` (`assertPublicResolution`, opt out with `BYTE_PI_WEB_ALLOW_TUN_FAKEIP=0`) — a node_modules patch that must be re-applied after the package is upgraded.

---

## Friends

- [Linux.do](https://linux.do/) — a friendly Chinese tech community

## License

MIT
