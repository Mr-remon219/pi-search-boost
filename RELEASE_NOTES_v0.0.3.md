# v0.0.3 — x_search: real-time X/Twitter search

## New

- **`x_search` tool** — real-time X (Twitter) search with four modes:
  - `keyword` — X advanced syntax (`from:user`, `since:YYYY-MM-DD`, `min_faves:N`, `lang:xx`)
  - `semantic` — natural-language relevance search
  - `user` — structured account profile + recent timeline (followers, bio, verified, posts with engagement) via X's anonymous guest GraphQL
  - `thread` — full conversation by post id (or `x.com/.../status/<id>` URL)
- **Parallel instant search** — `keyword`/`semantic` run two channels concurrently and merge, deduped by status id/URL:
  1. the hosted `x_search` tool (grok login / `XAI_API_KEY`) — live in-app search
  2. the fused multi-engine route (`Tavily`/`Brave`/`Exa` or `exa-free`, site-restricted to x.com) — returns in seconds
- **Works with no credentials at all** — a fast synchronous preflight routes straight to the multi-engine path (~2s instead of waiting out a timeout), with oEmbed full-text enhancement for the top hits; `user` falls back from guest GraphQL to engine profile links.
- **`/x-login` command** — imports your grok login into pi's own directory (`~/.pi/agent/xsearch-auth.json`), or stores an `XAI_API_KEY`; `status` shows the credential chain. OIDC access tokens auto-refresh (discovery + form POST) with best-effort write-back to grok's own auth file.

## How it works (no subprocess)

pi itself POSTs the Responses-API request to the sampling endpoint with `tools: [{"type": "x_search", ...}]`:

- API key → `https://api.x.ai/v1/responses` (public, [docs](https://docs.x.ai/developers/tools/x-search))
- grok login → `https://cli-chat-proxy.grok.com/v1/responses` (the CLI's internal endpoint; `x-grok-client-version` gate satisfied)

## Fallback routing (by type)

```
keyword/semantic → hosted x_search ∥ multi-engine (merged) → multi-engine + oEmbed
user             → hosted x_search → guest GraphQL (structured) → multi-engine profiles
thread           → hosted x_search → oEmbed single-post full text
```

## Fixes / improvements

- `search-audit recent` now renders `xsearch` events
- `AuditFetchEvent.via` accepts `"search"` (matches `extract.ts` reality)
- IPv4-forced DNS for direct-to-X fetches (Windows undici IPv6-first connect timeouts)
- `<search_balance>` tool-routing table now routes X-specific questions to `x_search`

## New files

- `lib/xsearch.ts` — hosted-tool direct HTTP client + credential preflight
- `lib/xauth.ts` — credential chain (env → pi-local copy → grok file) + OIDC refresh
- `lib/xfallback.ts` — multi-engine/oEmbed/guest-GraphQL fallback router

## Upgrade

```
pi install update git:github.com/Mr-remon219/pi-search-boost
# or, if installed from a local clone:
git pull && pi install .
```

Then `/reload` in pi, and optionally `/x-login` to import your grok login.
