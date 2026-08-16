# AGENTS.md

## Cursor Cloud specific instructions

### What this repo is
`pi-search-boost` is a **TypeScript extension for the `pi` coding agent** (`@earendil-works/pi-coding-agent`). It is not a standalone app: `index.ts` exports `searchBoostExtension(pi)` which registers 4 tools (`fused_search`, `fetch_page`, `deep_research`, `research_parallel`) + 2 TUI commands (`/search-cache`, `/search-audit`) and injects the `<search_balance>` policy into pi's system prompt. See `README.md` for the full design.

There is **no `package.json`, no lockfile, and no lint/test/build tooling** in this repo — pi runs the `.ts` files directly (no bundler). The only documented verification is a manual smoke test. Dependencies (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`) are provided by the installed `pi` runtime, not vendored here.

### Runtime / environment (already set up by the update script)
- The `pi` CLI is installed globally via npm into `~/.npm-global` and is on `PATH` for login shells (added to `~/.bashrc`). `~/.npmrc` sets `prefix=~/.npm-global` so `npm install -g` is writable. Because of this prefix, nvm prints a harmless warning (`.npmrc ... incompatible with nvm`) at shell start — ignore it; `pi` still resolves and runs.
- The update script also re-deploys this repo's files into `~/.pi/agent/extensions/search-boost/` (pi's auto-discovery dir). This deployment is **required for `research_parallel`**, which spawns `pi` child processes pointed at `getAgentDir()/extensions/search-boost/index.ts` (see `lib/parallel.ts`). Keep that copy in sync with the repo (the update script does this automatically).

### Running the extension end-to-end (needs an LLM API key)
The full agent loop drives an LLM that decides to call the tools. pi defaults to provider `google` (model `gemini-*`), so set `GEMINI_API_KEY` (or use another provider + `--provider/--model`, or `pi /login`). Example smoke test:
```bash
pi -ne -e /workspace/index.ts -p "fused_search 'tokio latest version'"
```
Without a key, pi loads the extension and registers all tools, then fails only at the LLM call with an API-key error — that error still confirms the extension itself loaded cleanly.

### Testing the core WITHOUT an LLM key (fast, no key required)
The value of this repo lives in `lib/` and is LLM-free. `fused_search`, `fetch_page`, and `deep_research` can be exercised directly against the live web (free layer = keyless Exa MCP + Jina Reader, no API keys needed; api layer = Tavily/Brave/Exa keys — switch with `/web_change`). `lib/engines.ts`, `lib/extract.ts`, `lib/research.ts`, `lib/cache.ts`, and `lib/util.ts` import only each other + node built-ins, so a tiny harness that imports them runs under node type-stripping:
```bash
node --experimental-strip-types your_harness.ts   # import { fusedSearch } from "/workspace/lib/engines.ts"
```
Only `research_parallel` (spawns `pi` subprocesses) and the `index.ts` registration layer require the `pi` deps.

Search API keys (needed for the api layer only; the free layer needs none): `PI_SEARCH_TAVILY_KEY`, `PI_SEARCH_EXA_KEY`, `PI_SEARCH_BRAVE_KEY` — see `.env.example`.
