# v0.1.2 — audit fixes, first-run UX, test suite

## Bug fixes

- **x_search**: cache hits use the same human-readable renderer as live results; normalize single-object vs array payloads; reject mutually exclusive `allowed_x_handles` / `excluded_x_handles`; strip markdown JSON fences before parsing; combine caller `signal` with request timeout
- **fused_search**: `domainBonus` no longer junk-penalizes domains explicitly included via `include_domains` (fixes `site:x.com` scoring)
- **fetch_page**: encode URLs for Jina Reader (`encodeURIComponent`)
- **research_parallel**: resolve extension entry via `import.meta.url` (works for npm / git / manual installs); enforce ≥2 subtasks in schema and at runtime
- **layer state**: mtime-based cache invalidation; default layer is `free` when no API keys are configured, `api` when keys are present
- **x-login**: parse `-k` / `--key` values that contain spaces
- **xfallback thread**: accept any numeric post id (not only 5+ digits)

## UX & docs

- **`/web_change`**: contextual hints when no API keys are configured or when on the free layer
- **AGENTS.md / README**: updated for pi-package layout, test scripts, and keyless-first defaults
- **install.sh / install.bat**: messaging aligned with free-layer (exa-free) instead of retired Bing HTML

## Tests

- **Unit tests**: domain scoring, JSON fence extraction, extension path resolution (+37 total)
- **Black-box tests** (`npm run test:blackbox`): live fused_search, fetch_page, deep_research, x_search fallback, pi extension load smoke test
- **package.json scripts**: `npm test`, `npm run test:blackbox`, `npm run test:all`

## Verified

- 37/37 unit tests pass
