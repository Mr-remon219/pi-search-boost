## v0.0.1 — Multi-engine search enhancement for pi

Initial release. Turns pi's web search into a research-grade capability: fused multi-engine retrieval, deep research loops, parallel subagents, focus-filtered page reading, caching, and full auditability.

### Features

- **`fused_search`** — 5-engine parallel search (Bing + Brave HTML keyless, Tavily, Exa, Brave), URL dedupe, cross-engine scoring, engine provenance per result; keyless mode keeps two independent free channels for cross-checking
- **Complexity routing** — `simple` (1×2 engines, 1 credit) / `medium` (2×3) / `complex` (3×4 + advanced extraction, 2 credits); simple lookups stop costing like deep research
- **`fetch_page` with `focus`** — dynamic filtering keeps only query-relevant paragraphs: **95% token savings** (1136 → 61 words measured); Jina Reader → local extractor → headless-browser fallback chain
- **`deep_research`** — multi-round loop (search → fetch → coverage check → follow-ups → converge), per-source corroboration (≥2 independent domains), temporal freshness, `mode=step` for agent-driven iteration
- **`research_parallel`** — 2-4 independent subagent processes (own context, own search budget); measured 3 subtasks in ~65s vs ~160s serial
- **x-algorithm-inspired ranking** — per-domain soft diversity decay (each further hit from the same domain × 0.7 down to a 0.35 floor) instead of a hard 2/domain cut; score parameters centralized (`SCORE_PARAMS`)
- **`<search_balance>` policy injection** — proactive-search ruleset: when to search / skip / stop (anti-over-search), autonomy rules (curl fallback), coding-time triggers (search before writing against an unsure API), doubt-triggered search ("I'm not sure" is the signal); live search-budget state injected on agent start
- **Caching & audit** — search cache 6h / page cache 24h (hot hits ~1ms, cross-process); JSONL audit log with tier distribution, Tavily credit estimation, engine errors, repeated-query loop detection; `/search-audit` and `/search-cache` TUI commands

### Measured performance

| Metric | Value |
| --- | --- |
| Simple query | ~1.0s |
| Medium query | ~3.2s |
| Complex query | ~3.6s |
| Deep research round | 9.8s (converged) |
| Hot cache hit | 1-3ms |
| Focus filtering | 95% token savings |
| research_parallel (3 subtasks) | ~65s (vs ~160s serial) |

### Install

```bash
# Windows
install.bat
# macOS / Linux
chmod +x install.sh && ./install.sh
```

Optional API keys: Tavily (1000 free credits/mo), Exa, Brave — keyless mode (Bing + Brave HTML + Jina) works without any.

### Known limitations

- Without API keys: two free engines (Bing + Brave HTML) — quality slightly lower, and free channels are subject to anti-bot rate limits
- Proactive search is policy-driven (system prompt), not RL-trained — empirically equivalent to model-decided triggering on mainstream agents
- No X/Twitter data source (paid API; guest-token scraping is dead)
- Bing/Brave HTML parsing depends on page structure (changes detected, fail loudly)
