/**
 * Deep research loop (step 2) — modeled on OpenDeepResearcher's iterate-until-
 * confident design, adapted to run inside a tool without an internal LLM call:
 *
 *  auto mode: fused search -> fetch top pages -> extract excerpts -> coverage
 *             check -> generate follow-up queries from new material -> repeat
 *             until coverage is reached (no new domains, source cap, or round cap).
 *  step mode: one round only; returns uncovered terms + suggested queries so the
 *             agent (the LLM) drives the loop itself, Grok-style.
 *
 * Corroboration (step 4): each source's excerpts are cross-compared with other
 * sources; sources sharing distinctive terms are reported as corroborating,
 * which lets the LLM require >=2 independent domains for key claims.
 */
import { JsonCache } from "./cache.ts";
import { fusedSearch, suggestFollowups } from "./engines.ts";
import { fetchPage, pickExcerpts, type PageResult } from "./extract.ts";
import {
	distinctiveTerms, hostOf, nowIso, pool, queryTerms,
} from "./util.ts";

export interface ResearchSource {
	title: string;
	url: string;
	domain: string;
	fetchedAt: string;
	via: PageResult["via"] | "search"; // "search" = content came from the search result itself
	wordCount: number;
	excerpt: string;
	corroboratedBy: string[]; // domains sharing distinctive terms in excerpts
}

export interface CoverageReport {
	totalSources: number;
	distinctDomains: number;
	primaryDomains: string[];
	coveredTerms: string[];
	uncoveredTerms: string[];
	newDomainsThisRound: number;
}

export interface ResearchResult {
	query: string;
	goal?: string;
	rounds: number;
	mode: "auto" | "step";
	stopReason: string;
	sources: ResearchSource[];
	coverage: CoverageReport;
	suggestedQueries: string[];
	engineStats: Record<string, unknown>;
	cacheHits: number;
	tookMs: number;
	finishedAt: string;
}

export interface ResearchOptions {
	query: string;
	goal?: string;
	mode?: "auto" | "step";
	maxRounds?: number;
	maxSources?: number;
	perRound?: number;
	engines?: string[];
	includeDomains?: string[];
	excludeDomains?: string[];
	recency?: "day" | "week" | "month" | "year" | "any";
	cache?: JsonCache;
	signal?: AbortSignal;
	progress?: (msg: string) => void;
}

function assertNotAborted(signal?: AbortSignal) {
	if (signal?.aborted) throw new Error("aborted");
}

export async function runResearch(opts: ResearchOptions): Promise<ResearchResult> {
	const started = Date.now();
	const query = opts.query;
	const goal = opts.goal;
	const mode = opts.mode ?? "auto";
	const maxRounds = Math.min(5, Math.max(1, opts.maxRounds ?? 3));
	const maxSources = Math.min(15, Math.max(1, opts.maxSources ?? 8));
	const perRound = Math.min(6, Math.max(2, opts.perRound ?? 3));
	const engines = opts.engines;
	const cache = opts.cache;
	const progress = opts.progress ?? (() => {});

	const seenUrls = new Set<string>();
	const seenDomains = new Set<string>();
	const sources: ResearchSource[] = [];
	const terms = new Set(queryTerms(query));
	const coveredTerms = new Set<string>();
	let cacheHits = 0;
	let engineStats: Record<string, unknown> = {};
	let suggestedQueries: string[] = [];
	let nextQueries: string[] | undefined; // fed back into the next round's search
	let stopReason = "max_rounds";
	let rounds = 0;
	let newDomainsThisRound = 0;

	for (let round = 1; round <= maxRounds; round++) {
		assertNotAborted(opts.signal);
		rounds = round;
		const remaining = maxSources - sources.length;
		if (remaining <= 0) {
			stopReason = "source_cap";
			break;
		}

		progress(`round ${round}/${maxRounds}: searching (${sources.length}/${maxSources} sources so far)`);
		const fused = await fusedSearch({
			query,
			queries: nextQueries, // round 2+: search with the gaps found last round
			engines,
			maxResults: perRound * 3,
			maxPerEngine: perRound * 2,
			includeDomains: opts.includeDomains,
			excludeDomains: opts.excludeDomains,
			recency: opts.recency,
			// research is a complex-tier task: full engines + advanced depth
			// (query-aligned content is consumed directly, skipping fetches)
			complexity: "complex",
			depth: "advanced",
			cache,
			signal: opts.signal,
			progress,
		});
		cacheHits += fused.cacheHits;
		// accumulate engine stats across rounds (was: last round only, hiding
		// earlier engine failures from the audit trail)
		const stats = engineStats as Record<string, { errors?: number; cacheHits?: number; note?: string }>;
		for (const [name, s] of Object.entries(fused.engineStats)) {
			const acc = (stats[name] ??= {});
			acc.errors = (acc.errors ?? 0) + s.errors;
			acc.cacheHits = (acc.cacheHits ?? 0) + s.cacheHits;
			if (s.note && !acc.note) acc.note = s.note;
		}

		// pick unseen results, prefer higher score
		const candidates = fused.results.filter((r) => !seenUrls.has(r.url)).slice(0, perRound);
		if (candidates.length === 0) {
			stopReason = "no_new_results";
			break;
		}

		progress(`round ${round}: fetching ${candidates.length} pages`);
		// concurrency 2: parallel jina fetches trigger free-tier rate limits,
		// which are the #1 cause of slow research runs (measured 68s baseline)
		const pages = await pool(candidates, 2, async (hit) => {
			assertNotAborted(opts.signal);
			// GPT-Researcher pattern: if the search result already carries full
			// extracted content (tavily advanced / exa text), consume it directly
			// instead of fetching the page — skips the slowest stage entirely.
			const words = (t: string) => t.trim().split(/\s+/).length;
			if (hit.content && words(hit.content) >= 300) {
				return {
					title: hit.title,
					url: hit.url,
					via: "search" as const,
					content: hit.content,
					fetchedAt: nowIso(),
					links: [],
				};
			}
			try {
				return await fetchPage(hit.url, { cache, signal: opts.signal, focus: query });
			} catch {
				return null;
			}
		});

		newDomainsThisRound = 0;
		const roundTitles: string[] = [];
		const roundDomains: string[] = [];
		for (let i = 0; i < candidates.length; i++) {
			const page = pages[i];
			if (!page) continue;
			const hit = candidates[i];
			seenUrls.add(hit.url);
			const domain = hostOf(hit.url);
			if (!seenDomains.has(domain)) {
				seenDomains.add(domain);
				newDomainsThisRound++;
				roundDomains.push(domain);
			}
			const excerpts = pickExcerpts(page.content, query, 2);
			if (excerpts.length > 0) {
				for (const t of terms) {
					if (page.content.toLowerCase().includes(t.toLowerCase())) coveredTerms.add(t);
				}
			}
			roundTitles.push(page.title || hit.title);
			sources.push({
				title: page.title || hit.title,
				url: page.url,
				domain,
				fetchedAt: page.fetchedAt,
				via: page.via,
				wordCount: page.wordCount,
				excerpt: excerpts.join(" ... "),
				corroboratedBy: [],
			});
			if (sources.length >= maxSources) break;
		}

		// corroboration pass (step 4): sources sharing >=2 distinctive terms.
		// Same-domain pages do NOT count as corroboration (not independent).
		const sourceExcerpts = sources.map((s) => distinctiveTerms(s.excerpt, 8));
		sources.forEach((s, i) => {
			const mine = new Set(sourceExcerpts[i]);
			const corr = new Set<string>();
			sources.forEach((o, j) => {
				if (i === j || o.domain === s.domain) return;
				let shared = 0;
				for (const t of sourceExcerpts[j]) if (mine.has(t)) shared++;
				if (shared >= 2) corr.add(o.domain);
			});
			s.corroboratedBy = [...corr];
		});

		// coverage check
		const uncovered = [...terms].filter((t) => !coveredTerms.has(t));
		const primaryDomains = [...seenDomains].filter(
			(d) => d.endsWith(".gov") || d.endsWith(".edu") || d === "wikipedia.org",
		);

		if (sources.length >= maxSources) {
			stopReason = "source_cap";
			break;
		}
		if (newDomainsThisRound === 0) {
			stopReason = "no_new_domains";
			break;
		}
		if (uncovered.length === 0 && sources.length >= Math.min(3, maxSources)) {
			stopReason = "terms_covered";
			break;
		}

		// follow-up queries from new material (OpenDeepResearcher-style gap filling)
		suggestedQueries = suggestFollowups(query, roundTitles, roundDomains, 4);
		if (suggestedQueries.length > 0) {
			nextQueries = suggestedQueries;
			if (round < maxRounds) {
				progress(`round ${round}: gaps -> follow-ups: ${suggestedQueries.join(" | ")}`);
			}
		} else {
			// nothing new to search for — further rounds would repeat the same pool
			stopReason = "no_followups";
			break;
		}
	}

	const coverage: CoverageReport = {
		totalSources: sources.length,
		distinctDomains: seenDomains.size,
		primaryDomains: [...seenDomains].filter(
			(d) => d.endsWith(".gov") || d.endsWith(".edu") || d === "wikipedia.org",
		),
		coveredTerms: [...coveredTerms],
		uncoveredTerms: [...terms].filter((t) => !coveredTerms.has(t)),
		newDomainsThisRound,
	};

	return {
		query,
		goal,
		rounds,
		mode,
		stopReason,
		sources,
		coverage,
		suggestedQueries,
		engineStats,
		cacheHits,
		tookMs: Date.now() - started,
		finishedAt: nowIso(),
	};
}
