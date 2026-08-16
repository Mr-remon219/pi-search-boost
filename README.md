# pi-search-boost

**Search-boost extension for [pi](https://github.com/earendil-works/pi-coding-agent) — turns pi's web search into a multi-engine, research-grade capability: fused multi-engine retrieval, deep research loops, parallel subagents, focus-filtered page reading, caching, and full auditability.**

The behavior layer is guided by a proactive-search policy (the `<search_balance>` ruleset) injected into the system prompt on agent start.

---

## What you get

- **Fused multi-engine search** — Tavily + Brave API + Exa in parallel (HTML scrapers retired)
- **Cross-engine ranking** — deduplicated by URL, cross-ranked by engine agreement and domain quality, with per-domain soft diversity decay; a result found by 2+ independent engines is high-confidence, single-engine noise is demoted
- **Complexity routing** — search budget bound to query complexity: `simple` = 1 variant × 2 engines (Tavily + Brave, 1 credit), `medium`/`complex` = 2–3 variants × Tavily + Brave + Exa (`complex` uses Tavily advanced, 2 credits)
- **Focus-filtered page reading** — `fetch_page` with a `focus` parameter keeps only query-relevant paragraphs (measured ~95% token savings)
- **Deep research loop** — search → fetch → extract → coverage check → follow-up queries → converge, with per-source corroboration (≥2 independent domains for key claims)
- **Parallel multi-agent research** — decompose a question into 2-4 subtasks, each run as an independent pi subprocess with its own search budget
- **Real-time X/Twitter search** — `x_search`: the hosted x_search tool (grok login / `XAI_API_KEY`) runs ∥ the fused multi-engine route in parallel, results merged and deduped; structured user profiles via X's anonymous guest GraphQL; oEmbed full-text; works with no credentials at all (~2s via multi-engine fallback)
- **Caching** — search results (6h) and pages (24h) persist to disk; hot cache hits are ~1ms, cross-process
- **Audit & observability** — every search/fetch/research event logged (JSONL, 5MB rotation) with tier, credits estimate, engine errors, timings; `/search-audit` and `/search-cache` commands in the TUI
- **Proactive-search policy** — a `<search_balance>` ruleset injected before agent start: when to search by default (any moment of doubt), when to skip, when to stop (~3 rounds diminishing returns), autonomy/fallback rules, and coding-time triggers (search before writing code against an API you are unsure about)

---

## Install — let pi do it

**Prerequisites:** pi installed (v0.84 or newer recommended; the extension uses `pi.registerTool` and the `before_agent_start` system-prompt injection). No build step, no bundler.

### Option A: install from npm (recommended)

Published as [`pi-search-boost`](https://www.npmjs.com/package/pi-search-boost) — pi installs it automatically (runs `npm install`, resolves peer deps):

```bash
# 1. Try it first without installing (runs once from a temp dir):
pi -e npm:pi-search-boost -p "fused_search 'tokio latest version'"

# 2. Install:
pi install npm:pi-search-boost
```

Then restart pi or run `/reload`. To update later: `pi update npm:pi-search-boost` (pinned version specs are skipped — install an explicit version to move: `pi install npm:pi-search-boost@0.1.0`).

### Option B: one-command install from git

No clone needed — pi clones the repo, registers it in `~/.pi/agent/settings.json`, and loads it as a package.

```bash
# 1. Try it first without installing (runs once from a temp dir):
pi -e git:github.com/Mr-remon219/pi-search-boost -p "fused_search 'tokio latest version'"

# 2. Install:
pi install git:github.com/Mr-remon219/pi-search-boost
```

Then restart pi or run `/reload`.

### Option C: clone, then install locally

```bash
git clone https://github.com/Mr-remon219/pi-search-boost.git
cd pi-search-boost
pi install .
```

### Option D: manual copy (fallback — no pi package mechanism)

```bash
# Windows
install.bat
# macOS / Linux
chmod +x install.sh && ./install.sh
```

Copies the extension to `~/.pi/agent/extensions/search-boost/` (pi auto-discovers extensions there).

### Have pi finish the setup for you

Once installed, paste this into a pi session — the agent reads this README and does the rest:

> Read this README and complete the setup for me: confirm the extension loaded (search-audit stats), walk me through API keys (or configure the ones I paste), and run the verification steps.

---

## Search layers: `/web_change`

Two layers, switched at runtime (persisted to `~/.pi/agent/search-boost-layer.json`). **Default:** `api` when Tavily/Brave/Exa keys are configured, otherwise `free` (keyless — works out of the box):

| Layer | Engines | Keys | Notes |
| --- | --- | --- | --- |
| `api` | Tavily + Brave + Exa API | `PI_SEARCH_TAVILY_KEY`, `PI_SEARCH_EXA_KEY`, `PI_SEARCH_BRAVE_KEY` | Multi-engine fusion, cross-engine scoring active |
| `free` | `exa-free` (keyless Exa MCP, `mcp.exa.ai`) | none | Single engine, no fusion cross-check, ~2-3s/call, may 429; 429 hint suggests switching back to `api` |

```
/web_change          # show current layer + available engines
/web_change free     # keyless Exa MCP, single engine
/web_change api      # tavily + brave + exa multi-engine fusion
```

The choice is read at every `fused_search` call, so `deep_research` and `research_parallel` inherit the active layer automatically.

---

## API keys (required for the api layer; free layer needs none)

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
| `x_search` | Real-time X/Twitter search (posts, users, threads). keyword/semantic run the hosted x_search tool ∥ the fused multi-engine route in parallel and merge results; works with or without credentials (multi-engine + oEmbed fallback; guest GraphQL for structured user profiles) |

### fused_search parameters

| Parameter | Description |
| --- | --- |
| `query` | The question or topic |
| `queries` | Optional keyword variants (auto-derived if omitted) |
| `engines` | Subset override: `tavily`, `exa`, `brave` (api layer) or `exa-free` (free layer); default = active layer's engines |
| `max_results` | Max fused results (1-20, default 10) |
| `include_domains` / `exclude_domains` | Hard client-side domain filters (engines ignore `site:` operators) |
| `recency` | `day`/`week`/`month`/`year` — half-life exponential decay for dated results |
| `min_score` | Drop results below a fused-score floor |
| `depth` | Tavily depth: `basic` (1 credit) / `advanced` (2 credits, query-aligned full extraction) |
| `complexity` | `auto`/`simple`/`medium`/`complex` — budget tier override |

Query style: stack 3-6 domain keywords plus specific terms (Grok Build style). `site:example.com` is auto-translated to a client-side include filter; `"a" OR "b"` auto-splits into parallel variants.

`fused_search` is the single search entry point (quick lookups: `complexity: "simple"`); `fetch_page` handles all page reading. No companion package is needed.

### x_search parameters

| Parameter | Description |
| --- | --- |
| `type` | `keyword` (X advanced syntax: `from:user`, `since:YYYY-MM-DD`, `min_faves:N`), `semantic` (natural language), `user` (structured profile + timeline), `thread` (conversation by post id / status URL) |
| `query` / `username` / `post_id` | Target per type |
| `from_date` / `to_date` | Date range (keyword/semantic) |
| `allowed_x_handles` / `excluded_x_handles` | Hosted-tool handle filters (max 20, mutually exclusive) |
| `model` / `reasoning_effort` | Driving model (default `grok-4.6`) and reasoning effort (default `low` — fast; results identical) |

Routing: `keyword`/`semantic` → hosted x_search (grok login / `XAI_API_KEY`) ∥ fused multi-engine (site-restricted to x.com) in parallel, merged and deduped; with **no credentials** the multi-engine route + oEmbed full-text enhancement returns in ~2s. `user` → guest GraphQL (anonymous X web API: followers, bio, verified, recent posts with engagement) → multi-engine profile links. `thread` → oEmbed single-post full text.

Credentials: `/x-login` imports your grok login into pi's own directory (`~/.pi/agent/xsearch-auth.json`); tokens auto-refresh (OIDC). No subprocess is ever spawned — pi POSTs the Responses-API request itself.

### TUI commands

- `/web_change [free|api|show]` — switch the search layer (free = keyless Exa MCP single engine; api = tavily+brave+exa fusion)
- `/x-login [|-k <XAI_API_KEY>|status]` — import xAI credentials into pi's own directory for x_search (bare = from your grok login; `-k` = API key; `status` = show the credential chain)
- `/x-logout` — remove pi-local credentials: the official hosted x_search path is disabled, x_search falls back to the multi-engine / guest-GraphQL / oEmbed chain only (grok CLI's own login is untouched; `/x-login` re-enables the official path)
- `/search-audit stats|recent|failures|domains|clear` — analyze the audit log: event counts, fetch success rates, engine errors, tier distribution, Tavily credit estimate, failing domains
- `/search-cache stats|clear` — inspect or clear the cache

---

## Architecture

```
index.ts        Tool registrations (fused_search, fetch_page, deep_research,
                research_parallel, x_search), TUI commands, <search_balance> ruleset
                injection
lib/engines.ts  Engine adapters (Tavily, Exa, Brave API, exa-free MCP), query preprocessing
                (site:/OR/quotes), complexity routing, cross-engine fusion scoring,
                recency decay
lib/xsearch.ts  x_search primary path: pi POSTs the Responses API directly (hosted
                x_search tool) with grok's OIDC session or XAI_API_KEY — no subprocess;
                fast credential preflight (xAuthAvailableSync)
lib/xauth.ts    Credential chain for x_search: XAI_API_KEY env → pi-local copy
                (xsearch-auth.json, written by /x-login) → ~/.grok/auth.json; OIDC
                token refresh with best-effort grok-file sync
lib/xfallback.ts Credential-free fallback routing: multi-engine (site:x.com) + oEmbed
                full-text enhancement; guest GraphQL (anonymous X web API: token
                cached 2h, query ids self-heal on 404) for structured user profiles
lib/layer.ts    Layer state (free | api) with disk persistence, switched by /web_change
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

- **X/Twitter live data**: the hosted x_search path needs grok login or `XAI_API_KEY`; without credentials, `x_search` uses multi-engine + guest GraphQL + oEmbed fallbacks (indexed posts, not the full firehose).
- **Model-native triggering**: search triggering is policy-driven (system prompt), not RL-trained into the model.
- **No self-hosted index**: retrieval is proxied via Tavily / Brave / Exa / Exa MCP; there is no local index of the web.
- **API keys for fusion**: the `api` layer needs Tavily/Brave/Exa keys for multi-engine fusion; the `free` layer needs none but is a single keyless engine (Exa MCP) that can rate-limit (429) — switch with `/web_change api` once keys are configured.

---

## Development history

23 measured iterations (see the repo commit history): from single-engine Bing scraping → 4-engine fusion with complexity routing → focus-filtered reading (95% token savings) → deep research with corroboration → parallel subagents → proactive-search policy (v3: anti-over-search stop rules; v4: autonomy/fallback rules) → audit fixes → **round 23: TUN fake-ip carve-out (Clash TUN answers every DNS query with 198.18/15; the SSRF guard now allows an all-fake-ip hostname resolution while literal private IPs / loopback / metadata stay blocked; opt out with `PI_SEARCH_ALLOW_TUN_FAKEIP=0`) + single-policy merge (deduplicated the proactive-search ruleset into one `<search_balance>` with an explicit tool-routing section; the standalone web-search-guidance extension was retired).**
> Note for Clash/sing-box TUN users: without this fix, `fetch_page` fails on every real URL with "resolves to private IP 198.18.0.x".

---

## Friends

- [Linux.do](https://linux.do/) — a friendly Chinese tech community

## License

MIT
