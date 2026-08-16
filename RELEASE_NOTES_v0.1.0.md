# v0.1.0 — npm release

## What changed in this release

- **Published to npm** — `pi-search-boost` is now installable directly:

  ```bash
  pi install npm:pi-search-boost@0.1.0     # install
  pi -e npm:pi-search-boost               # try once without installing
  ```

- Version jumped 0.0.4 → 0.1.0 to mark the npm milestone. All v0.0.3/v0.0.4 features are included (see `RELEASE_NOTES_v0.0.3.md` / `RELEASE_NOTES_v0.0.4.md`).

## Feature summary (v0.0.3 + v0.0.4)

- **`fused_search`** — multi-engine fusion: Tavily + Brave + Exa in parallel (api layer) or keyless exa-free MCP (free layer), URL dedupe, cross-engine scoring, complexity routing, recency decay, domain filters
- **`fetch_page`** — focus-filtered reading (~95% token savings)
- **`deep_research`** / **`research_parallel`** — multi-round loop with coverage checks / parallel subagents
- **`x_search`** — real-time X/Twitter search:
  - `keyword` / `semantic` / `user` / `thread` modes (all four Grok Build sub-tools covered)
  - parallel instant search: hosted x_search (grok login / `XAI_API_KEY`) ∥ fused multi-engine, merged + deduped
  - works with **no credentials** (multi-engine + oEmbed ~2s; structured user profiles via anonymous guest GraphQL)
  - `/x-login` enables the official hosted path (imports grok login or stores an API key); `/x-logout` disables it and returns to the fallback chain only

## npm package contents

`index.ts`, `lib/` (xsearch, xauth, xfallback, engines, extract, research, parallel, cache, audit, layer, util), README (EN/ZH), release notes, AGENTS.md, LICENSE.

## Verified

- 33/33 unit tests pass
- type check: 0 new-region errors
- live x_search: keyword 8 results (grok session), parallel merge 13 = x 8 + engines 5, no-credential path ~2s
- credential lifecycle: login → available → logout → fallback-only → login → available
