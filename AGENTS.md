# AGENTS.md

## Cursor Cloud specific instructions

### What this repo is
`pi-search-boost` is a **TypeScript pi-package** (`package.json` → `pi.extensions`) for the [`pi`](https://github.com/earendil-works/pi-coding-agent) coding agent. `index.ts` exports `searchBoostExtension(pi)` which registers **5 tools** (`fused_search`, `fetch_page`, `deep_research`, `research_parallel`, `x_search`) + **5 TUI commands** (`/search-cache`, `/search-audit`, `/web_change`, `/x-login`, `/x-logout`) and injects the `<search_balance>` policy into pi's system prompt. See `README.md` for the full design.

Dependencies (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`) are peer deps resolved by the installed `pi` runtime — no bundler.

### Runtime / environment
- The `pi` CLI is installed globally via npm into `~/.npm-global` and is on `PATH` for login shells (added to `~/.bashrc`). `~/.npmrc` sets `prefix=~/.npm-global` so `npm install -g` is writable. Because of this prefix, nvm prints a harmless warning (`.npmrc ... incompatible with nvm`) at shell start — ignore it; `pi` still resolves and runs.
- **Install paths:** `pi install npm:pi-search-boost` / `pi install .` / `pi install git:…` all work. `research_parallel` resolves the extension entry via `import.meta.url` (package-local `index.ts`), so it does **not** require a separate copy under `~/.pi/agent/extensions/search-boost/` — though `install.sh` still supports manual copy for discovery-only setups.

### Search layers (first-run UX)
- `/web_change` switches `free` (keyless Exa MCP) vs `api` (Tavily+Brave+Exa).
- **Default layer:** `api` when any `PI_SEARCH_*` key is set, otherwise `free` — so keyless users can search immediately.
- Persisted to `~/.pi/agent/search-boost-layer.json`.

### Running the extension end-to-end (needs an LLM API key)
The full agent loop drives an LLM that decides to call the tools. pi defaults to provider `google` (model `gemini-*`), so set `GEMINI_API_KEY` (or use another provider + `--provider/--model`, or `pi /login`). Example smoke test:
```bash
pi -ne -e /workspace/index.ts -p "fused_search 'tokio latest version'"
```
Without a key, pi loads the extension and registers all tools, then fails only at the LLM call with an API-key error — that error still confirms the extension itself loaded cleanly.

### Testing WITHOUT an LLM key
**Unit tests (offline, fast):**
```bash
npm test
# or: node --experimental-strip-types --test test/unit.test.ts
```

**Black-box / integration tests (live network, free layer — no API keys):**
```bash
npm run test:blackbox
# or: node --experimental-strip-types --test test/blackbox.test.ts
```
Covers `fused_search` (exa-free), `fetch_page` (Jina), `deep_research` step mode, `x_search` fallback, pi extension load smoke test, and cache/audit side effects.

**Direct lib harness** (LLM-free, for debugging a single module):
```bash
node --experimental-strip-types your_harness.ts   # import { fusedSearch } from "/workspace/lib/engines.ts"
```

Search API keys (api layer only; free layer needs none): `PI_SEARCH_TAVILY_KEY`, `PI_SEARCH_EXA_KEY`, `PI_SEARCH_BRAVE_KEY` — see `.env.example`.

### Sync manual extension copy (optional)
```bash
./install.sh   # copies to ~/.pi/agent/extensions/search-boost/
```
