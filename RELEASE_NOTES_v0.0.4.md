# v0.0.4 — /x-logout: explicit credential switch for x_search

## New

- **`/x-logout`** — removes the pi-local credential copy (`~/.pi/agent/xsearch-auth.json`). The official hosted x_search path is then disabled and `x_search` uses only the multi-engine / guest-GraphQL / oEmbed fallback chain. grok CLI's own login is never touched; `/x-login` re-enables the official path.

## Behavior change

- **The official path must be explicitly enabled.** `~/.grok/auth.json` is no longer auto-consumed by `x_search`: previously a grok login on disk was silently picked up; now only `XAI_API_KEY` env or a pi-local copy written by `/x-login` (or `/x-login -k`) unlocks the hosted `x_search` tool. Without either, `x_search` routes straight to the fallback chain (~2s multi-engine + oEmbed, structured users via guest GraphQL).
- `/x-login status` now marks a present-but-not-imported grok file as `NOT imported; run /x-login to enable the official x_search path`.

## Why

An explicit switch: you decide when the official (xAI-hosted) path is used. `/x-logout` = "my implementation only" (multi-engine route, guest GraphQL, oEmbed); `/x-login` = "official hosted x_search also available" (parallel instant search).

## Verified

- lifecycle: no creds → unavailable → `/x-login` → available → `/x-logout` → unavailable (even with grok's file present) → re-`/x-login` → available
- fallback chain still works after logout: keyword `engines+oembed` ~3s; user `guest-graphql` (structured profile)
- type check: 0 new-region errors
