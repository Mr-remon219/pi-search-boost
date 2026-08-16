## v0.0.2 — Layers: keyless free tier via `/web_change`

Search layers, engine retirement, and hardening. The big change: **two switchable layers** — a keyless `free` layer (single engine, no API keys) and the multi-engine `api` layer — toggled at runtime with `/web_change` and persisted across reloads.

### Features

- **`/web_change [free|api|show]`** — switch the active search layer at runtime; persisted to `~/.pi/agent/search-boost-layer.json` (default `api`). `fused_search` output now reports the active layer; `deep_research` and `research_parallel` inherit it automatically (subprocesses read the same state file)
- **Free layer: keyless Exa MCP** — new `exa-free` engine adapter speaking the minimal MCP Streamable HTTP protocol (initialize → initialized → `tools/call web_search_exa`) against `mcp.exa.ai`; measured 4/4 correct-entity results in side-by-side probing; no API key required
- **Layer-aware complexity routing** — api: `simple` = 1×2 (tavily+brave) / `medium` = 2×3 / `complex` = 3×3 + tavily advanced; free: all tiers use exa-free with 1/2/3 variants
- **`fused_search` is now the single search entry point** — quick lookups pass `complexity: "simple"`; the companion-package references (`web_search` / `web_fetch`) were removed from the policy, tool descriptions, and docs

### Removed

- **Bing HTML engine** — retired. The channel never failed (0% HTTP errors over the audited window), but its entity resolution was wrong on every ambiguous probe: `tokio` → Tokyo Wikipedia, `pi` → π, `linux.do` → linux.org, and one clean query returned an entire page of Australian medical clinics. The `en-US` market pin reduced but did not fix the wrong-entity pollution
- **Brave HTML engine** — retired. 80% measured 429 rate from this IP (persistent IP-level rate limiting); unusable as a routing engine

### Fixed

- **exa-free MCP notification path** — `notifications/initialized` is answered with `202` + empty body; the old parser unconditionally called `resp.json()` and threw (silently swallowed). Now: read text first, treat empty body on notifications as success, parse SSE last-`data:`-line or JSON body explicitly
- **Dead-pool silent empty results** — with the api layer selected but zero API keys configured, `fused_search` returned nothing with no explanation. Now degrades to keyless `exa-free` and surfaces a `WARNING:` line (new `warnings[]` on the result)
- **Audit layer field** — search events now record `layer`; the `AuditSearchEvent` interface was updated to match
- **Tavily credit estimate** — `/search-audit stats` now counts only searches where tavily actually ran (free-layer searches no longer inflate the estimate) and shows a layer distribution line

### Other

- `research_parallel` subtask prompts now instruct subagents to drop to 1 variant on 429 instead of hammering
- Cache keys: `exa-free` is optionless (unfragmented keys, like the retired HTML scrapers)
- Tests: dropped `bingMarketForQuery`, added a web-layer state round-trip test, updated cache-key and cross-process cache tests

### Upgrade notes

- If you relied on keyless mode: it is now the `free` layer (`/web_change free`) — single engine, no cross-engine scoring, expect occasional 429
- If a caller passes `engines: ["bing"]` or `["bravehtml"]`, the request is ignored and the active layer's default engines are used (with a warning if that leaves the pool empty)
- Companion package `@bytetrue/pi-web-search` is no longer referenced; `pi remove npm:@bytetrue/pi-web-search` if installed
