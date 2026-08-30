# pi-search-boost v0.1.3

Correctness and security release for deep research, page fetching, cancellation, and parallel child-agent reliability.

## Security

- Closed the redirect-based SSRF gap in `fetch_page`: untrusted page redirects are followed manually, each `Location` target is revalidated, and redirect depth is bounded.
- Untrusted local extraction now uses a DNS-pinned `node:http(s)` transport: the address approved by the guard is the address used by the socket, while the original hostname remains available for Host/SNI. This closes the DNS rebinding check/connect gap.
- Loopback, RFC1918, link-local/cloud metadata, numeric hosts, private DNS answers, and unsafe schemes remain blocked. Clash fake-IP TUN access is security-first opt-in with `PI_SEARCH_ALLOW_TUN_FAKEIP=1` and requires every DNS answer to be in 198.18/15.

## Deep research correctness

- `goal` now drives initial searches, focus filtering, excerpt selection, evidence gaps, follow-up queries, and stopping conditions.
- Coverage is computed only from selected evidence excerpts, never from an arbitrary match elsewhere on the page.
- Goal subject terms require evidence from at least two independent domains.
- Time-sensitive goals/queries require the same aligned claim segments on two domains to carry recent dates; unrelated footer/copyright years cannot freshen stale claims.
- Results explicitly report `semanticGoalCheck: not_performed`; lexical evidence coverage is no longer presented as proof that the semantic goal was satisfied.
- Corroboration now compares claim-sized segments using boundary-aware query anchors and exact version/date/measure facts, rejects conflicting version/lifecycle-status claims, and is clearly labeled heuristic claim alignment rather than proof.
- Custom continuation queries retain a goal-bearing search variant, and domain stagnation must persist for two rounds before stopping while evidence gaps remain.

## Fetch and search reliability

- Tavily, Exa, Brave, and Exa MCP now combine caller cancellation with their engine timeout. Cancelling `deep_research` stops in-flight API work instead of consuming credits until timeout. One Exa MCP deadline covers its whole multi-stage session and bounded empty-result retry.
- Focus filtering caps repeated-word influence, rewards unique concept coverage, uses Latin token boundaries (`LTS` no longer matches `results`), preserves borderless/outer-pipe Markdown tables, and retains bounded heading/table context with complete relevant rows.

## Parallel research / WebSocket fixes

- Child Pi processes now use `-ne` before explicitly loading this extension, preventing duplicate tool registration when the npm package is already installed.
- Captures bounded child stderr so provider and startup failures are no longer hidden.
- Transient WebSocket/socket/provider transport failures retry once serially after the parallel wave, reducing concurrent connection pressure; persistent failures include an actionable `transport: auto/sse` diagnostic.
- Fixed abort cleanup, TERM→KILL escalation, killed-child success misclassification, stale parent session metadata, and Windows Pi CLI resolution without unsafe shell execution.
- Audit records now count actual cited URLs and distinct domains instead of model turns / hard-coded zero domains.

## Packaging and tests

- Published package now includes `test/` and a Node.js 22.6+ copy-out runner, so `npm test`, `npm run test:blackbox`, and `npm run test:all` work even when the package lives under `node_modules`.
- Cross-process cache read/merge/rename is protected by a stale-recovering file lock; a true concurrent child-process regression test verifies both writes survive.
- Added regression coverage for redirect SSRF policy, API cancellation, stale-claim/current-footer dates, conflicting lifecycle/version facts, Latin boundaries, borderless Markdown status tables, balanced-parenthesis URL auditing, serial WebSocket retry, and killed-child classification.
