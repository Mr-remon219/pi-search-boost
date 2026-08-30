/* Deep-research loop with evidence-based coverage and claim-level alignment. */
import { JsonCache } from "./cache.ts";
import { fusedSearch, suggestFollowups } from "./engines.ts";
import { fetchPage, pickExcerpts, type PageResult } from "./extract.ts";
import {
	containsSearchTerm, countWords, hostOf, nowIso, pool, queryTerms, throwIfAborted, tokenize,
} from "./util.ts";

export interface ResearchSource {
	title: string;
	url: string;
	domain: string;
	fetchedAt: string;
	via: PageResult["via"] | "search";
	wordCount: number;
	excerpt: string;
	/** Independent domains with a heuristically aligned claim excerpt. */
	corroboratedBy: string[];
	/** Aligned claim segments where both sides carry a recent date. */
	freshCorroboratedBy?: string[];
}

export interface CoverageReport {
	totalSources: number;
	distinctDomains: number;
	primaryDomains: string[];
	/** Query terms found in selected evidence excerpts (not anywhere on a page). */
	coveredTerms: string[];
	uncoveredTerms: string[];
	/** Goal subject terms require evidence from at least two independent domains. */
	goalTerms: string[];
	coveredGoalTerms: string[];
	uncoveredGoalTerms: string[];
	goalEvidenceDomains: string[];
	goalEvidenceCovered: boolean;
	timeSensitiveGoal: boolean;
	/** This non-LLM loop never claims that the semantic goal itself is satisfied. */
	semanticGoalCheck: "not_performed";
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
	corroborationMethod: string;
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
	queries?: string[];
	cache?: JsonCache;
	signal?: AbortSignal;
	progress?: (msg: string) => void;
}

const GOAL_INSTRUCTION_TERMS = new Set([
	"answer", "establish", "identify", "determine", "find", "report", "provide",
	"explain", "verify", "show", "tell", "whether", "must", "final",
	"回答", "确认", "识别", "确定", "查找", "报告", "说明", "验证", "给出", "最终",
]);

const TEMPORAL_TERMS = new Set([
	"current", "latest", "newest", "recent", "today", "now", "status", "active",
	"当前", "最新", "现在", "现行", "状态", "截至", "今日",
]);

const CLAIM_GENERIC_TERMS = new Set([
	"page", "source", "official", "information", "documentation", "using", "used",
	"release", "releases", "version", "versions", "current", "latest", "status",
	"页面", "来源", "官方", "信息", "文档", "使用", "发布", "版本", "状态", "最新", "当前",
]);

/** step mode is always one round; auto honors maxRounds (clamped 1–5). */
export function plannedResearchRounds(mode: "auto" | "step", requested?: number): number {
	if (mode === "step") return 1;
	return Math.min(5, Math.max(1, requested ?? 3));
}

export function isTimeSensitiveGoal(text?: string): boolean {
	if (!text) return false;
	return queryTerms(text).some((term) => TEMPORAL_TERMS.has(term.toLowerCase())) ||
		/\bas\s+of\b/i.test(text);
}

/** Remove instruction verbs: coverage should describe evidence subjects, not prompt wording. */
export function goalCoverageTerms(goal?: string): string[] {
	if (!goal) return [];
	return [...new Set(queryTerms(goal))].filter(
		(term) => !GOAL_INSTRUCTION_TERMS.has(term.toLowerCase()) && !TEMPORAL_TERMS.has(term.toLowerCase()),
	);
}

function containsTerm(text: string, term: string): boolean {
	return containsSearchTerm(text, term);
}

function evidenceDomainsForTerm(sources: ResearchSource[], term: string): Set<string> {
	const domains = new Set<string>();
	for (const source of sources) {
		if (source.excerpt && containsTerm(source.excerpt, term)) domains.add(source.domain);
	}
	return domains;
}

function yearsIn(text: string): number[] {
	return [...text.matchAll(/\b(19\d{2}|20\d{2}|21\d{2})\b/g)].map((m) => Number(m[1]));
}

function versionTokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const m of text.matchAll(/\bv?(\d{1,3}(?:\.\d+){1,3})\b/gi)) out.add(m[1]!.replace(/\.0+$/, ""));
	for (const m of text.matchAll(/\b(?:node(?:\.js)?|python|rust|go|java)\s*(?:version\s*)?v?(\d{1,3})\b/gi)) {
		out.add(m[1]!);
	}
	for (const m of text.matchAll(/\bv(\d{1,3})\b/gi)) out.add(m[1]!);
	return out;
}

function factTokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const v of versionTokens(text)) out.add(`version:${v}`);
	for (const year of yearsIn(text)) out.add(`year:${year}`);
	for (const m of text.matchAll(/\b\d+(?:\.\d+)?\s*(?:%|ms|s|gb|mb|tb|kb|x)\b/gi)) {
		out.add(`measure:${m[0]!.toLowerCase().replace(/\s+/g, "")}`);
	}
	return out;
}

function statusTokens(text: string): Set<string> {
	const out = new Set<string>();
	const lower = text.toLowerCase();
	if (/\bactive(?:\s+lts)?\b|活跃|积极维护/.test(lower)) out.add("active");
	const isEol = /\bend[- ]of[- ]life\b|\beol\b|停止维护|生命周期结束/.test(lower);
	if (/\bmaintenance(?:\s+lts)?\b/.test(lower) || (/维护/.test(lower) && !isEol)) out.add("maintenance");
	if (isEol) out.add("eol");
	return out;
}

function claimSegments(text: string): string[] {
	const segments = text
		.split(/\s+\.\.\.\s+|(?<=[.!?。！？])\s+|\n+/)
		.map((s) => s.trim())
		.filter((s) => countWords(s) >= 5);
	return segments.length > 0 ? segments : [text];
}

function intersectSize<T>(a: Set<T>, b: Set<T>): number {
	let n = 0;
	for (const value of a) if (b.has(value)) n++;
	return n;
}

function claimTerms(text: string): Set<string> {
	return new Set(tokenize(text).filter((t) => t.length >= 3 && !CLAIM_GENERIC_TERMS.has(t.toLowerCase())));
}

function claimsAlign(a: string, b: string, focusTerms: Set<string>, timeSensitive: boolean): boolean {
	const termsA = claimTerms(a);
	const termsB = claimTerms(b);
	const sharedContent = intersectSize(termsA, termsB);
	const union = new Set([...termsA, ...termsB]).size || 1;
	const jaccard = sharedContent / union;
	const focusA = new Set([...focusTerms].filter((t) => containsTerm(a, t)));
	const focusB = new Set([...focusTerms].filter((t) => containsTerm(b, t)));
	const sharedFocus = intersectSize(focusA, focusB);

	const versionsA = versionTokens(a);
	const versionsB = versionTokens(b);
	if (versionsA.size > 0 && versionsB.size > 0 && intersectSize(versionsA, versionsB) === 0) return false;
	const statusesA = statusTokens(a);
	const statusesB = statusTokens(b);
	if (statusesA.size > 0 && statusesB.size > 0 && intersectSize(statusesA, statusesB) === 0) return false;

	const factsA = factTokens(a);
	const factsB = factTokens(b);
	const sharedFacts = intersectSize(factsA, factsB);
	if (timeSensitive) return sharedFacts >= 1 && sharedFocus >= 1 && sharedContent >= 1;
	if (factsA.size > 0 && factsB.size > 0) {
		return sharedFacts >= 1 && sharedFocus >= 1 && sharedContent >= 1;
	}
	return sharedFocus >= 2 && sharedContent >= 3 && jaccard >= 0.12;
}

/**
 * Mark independent domains only when at least one pair of claim-sized segments
 * aligns on subject and either exact factual anchors or strong lexical overlap.
 * This is deliberately conservative and remains heuristic, not proof.
 */
export function applyCorroboration(
	sources: ResearchSource[],
	focus: string,
	timeSensitive = isTimeSensitiveGoal(focus),
): void {
	const focusTerms = new Set(queryTerms(focus).filter((t) => !TEMPORAL_TERMS.has(t.toLowerCase())));
	const segments = sources.map((source) => claimSegments(source.excerpt));
	const recentCutoff = new Date().getUTCFullYear() - 1;
	for (let i = 0; i < sources.length; i++) {
		const domains = new Set<string>();
		const freshDomains = new Set<string>();
		for (let j = 0; j < sources.length; j++) {
			if (i === j || sources[i]!.domain === sources[j]!.domain) continue;
			let aligned = false;
			let freshAligned = false;
			for (const a of segments[i]!) {
				for (const b of segments[j]!) {
					if (!claimsAlign(a, b, focusTerms, timeSensitive)) continue;
					aligned = true;
					if (
						yearsIn(a).some((year) => year >= recentCutoff) &&
						yearsIn(b).some((year) => year >= recentCutoff)
					) freshAligned = true;
				}
			}
			if (aligned) domains.add(sources[j]!.domain);
			if (freshAligned) freshDomains.add(sources[j]!.domain);
		}
		sources[i]!.corroboratedBy = [...domains].sort();
		sources[i]!.freshCorroboratedBy = [...freshDomains].sort();
	}
}

function freshAlignedDomainsForTerm(
	sources: ResearchSource[],
	term: string,
	focusTerms: Set<string>,
): Set<string> {
	const domains = new Set<string>();
	const recentCutoff = new Date().getUTCFullYear() - 1;
	const segments = sources.map((source) => claimSegments(source.excerpt));
	for (let i = 0; i < sources.length; i++) {
		for (let j = i + 1; j < sources.length; j++) {
			if (sources[i]!.domain === sources[j]!.domain) continue;
			const alignedFreshClaim = segments[i]!.some((a) =>
				containsTerm(a, term) && yearsIn(a).some((year) => year >= recentCutoff) &&
				segments[j]!.some((b) =>
					containsTerm(b, term) && yearsIn(b).some((year) => year >= recentCutoff) &&
					claimsAlign(a, b, focusTerms, true),
				),
			);
			if (alignedFreshClaim) {
				domains.add(sources[i]!.domain);
				domains.add(sources[j]!.domain);
			}
		}
	}
	return domains;
}

/** Evaluate coverage strictly from selected excerpts, never arbitrary page text. */
export function evaluateCoverage(
	query: string,
	goal: string | undefined,
	sources: ResearchSource[],
	newDomainsThisRound = 0,
): CoverageReport {
	const qTerms = [...new Set(queryTerms(query))];
	const gTerms = goalCoverageTerms(goal);
	const coveredTerms = qTerms.filter((term) => evidenceDomainsForTerm(sources, term).size >= 1);
	const coveredGoalTerms = gTerms.filter((term) => evidenceDomainsForTerm(sources, term).size >= 2);
	const goalDomains = new Set<string>();
	for (const term of gTerms) for (const domain of evidenceDomainsForTerm(sources, term)) goalDomains.add(domain);
	const timeSensitiveGoal = isTimeSensitiveGoal(goal ?? query);
	const temporalEvidenceTerms = goal
		? gTerms
		: qTerms.filter((term) => !TEMPORAL_TERMS.has(term.toLowerCase()));
	const temporalFocusTerms = new Set(temporalEvidenceTerms);
	const freshCoveredTemporalTerms = timeSensitiveGoal
		? temporalEvidenceTerms.filter(
			(term) => freshAlignedDomainsForTerm(sources, term, temporalFocusTerms).size >= 2,
		)
		: [];
	const temporalEvidenceCovered = !timeSensitiveGoal || (
		temporalEvidenceTerms.length > 0 &&
		freshCoveredTemporalTerms.length === temporalEvidenceTerms.length
	);
	const uncoveredGoalTerms = gTerms.filter((term) => !coveredGoalTerms.includes(term));
	const goalEvidenceCovered = !goal
		? temporalEvidenceCovered
		: gTerms.length > 0 && uncoveredGoalTerms.length === 0 && temporalEvidenceCovered;
	const domains = new Set(sources.map((source) => source.domain).filter(Boolean));
	return {
		totalSources: sources.length,
		distinctDomains: domains.size,
		primaryDomains: [...domains].filter((d) => d.endsWith(".gov") || d.endsWith(".edu")),
		coveredTerms,
		uncoveredTerms: qTerms.filter((term) => !coveredTerms.includes(term)),
		goalTerms: gTerms,
		coveredGoalTerms,
		uncoveredGoalTerms,
		goalEvidenceDomains: [...goalDomains].sort(),
		goalEvidenceCovered,
		timeSensitiveGoal,
		semanticGoalCheck: "not_performed",
		newDomainsThisRound,
	};
}

function initialQueries(query: string, goal?: string): string[] | undefined {
	const target = goal ?? query;
	const out = goal ? [query, `${query} ${goal}`] : [query];
	if (isTimeSensitiveGoal(target)) {
		out.push(`${target} ${new Date().getUTCFullYear()} official status`);
	}
	const unique = [...new Set(out)];
	return unique.length > 1 ? unique : undefined;
}

export function mergeInitialQueries(query: string, goal: string | undefined, custom?: string[]): string[] | undefined {
	const defaults = initialQueries(query, goal) ?? [];
	if (!custom?.length) return defaults.length > 0 ? defaults : undefined;
	// A continuation may target gaps, but it must not remove goal participation.
	const required = goal
		? [`${query} ${goal}`]
		: (isTimeSensitiveGoal(query) ? defaults.slice(-1) : []);
	return [...new Set([...required, ...custom])];
}

export async function runResearch(opts: ResearchOptions): Promise<ResearchResult> {
	const started = Date.now();
	const query = opts.query;
	const goal = opts.goal;
	const focus = goal ? `${query}\n${goal}` : query;
	const mode = opts.mode ?? "auto";
	const maxRounds = plannedResearchRounds(mode, opts.maxRounds);
	const maxSources = Math.min(15, Math.max(1, opts.maxSources ?? 8));
	const perRound = Math.min(6, Math.max(2, opts.perRound ?? 4));
	const cache = opts.cache;
	const progress = opts.progress ?? (() => {});
	const seenUrls = new Set<string>();
	const seenDomains = new Set<string>();
	const sources: ResearchSource[] = [];
	let cacheHits = 0;
	let engineStats: Record<string, unknown> = {};
	let suggestedQueries: string[] = [];
	let nextQueries = mergeInitialQueries(query, goal, opts.queries);
	let stopReason = "max_rounds";
	let rounds = 0;
	let newDomainsThisRound = 0;
	let stagnantDomainRounds = 0;

	for (let round = 1; round <= maxRounds; round++) {
		throwIfAborted(opts.signal);
		rounds = round;
		if (maxSources - sources.length <= 0) {
			stopReason = "source_cap";
			break;
		}
		progress(`round ${round}/${maxRounds}: searching (${sources.length}/${maxSources} sources so far)`);
		const fused = await fusedSearch({
			query: focus,
			queries: nextQueries,
			engines: opts.engines,
			maxResults: perRound * 3,
			maxPerEngine: perRound * 2,
			includeDomains: opts.includeDomains,
			excludeDomains: opts.excludeDomains,
			recency: opts.recency,
			complexity: "complex",
			depth: "advanced",
			cache,
			signal: opts.signal,
			progress,
		});
		cacheHits += fused.cacheHits;
		const stats = engineStats as Record<string, { errors?: number; cacheHits?: number; note?: string }>;
		for (const [name, stat] of Object.entries(fused.engineStats)) {
			const acc = (stats[name] ??= {});
			acc.errors = (acc.errors ?? 0) + stat.errors;
			acc.cacheHits = (acc.cacheHits ?? 0) + stat.cacheHits;
			if (stat.note && !acc.note) acc.note = stat.note;
		}

		const candidates = fused.results.filter((result) => !seenUrls.has(result.url)).slice(0, perRound);
		if (candidates.length === 0) {
			stopReason = "no_new_results";
			break;
		}
		progress(`round ${round}: fetching ${candidates.length} pages`);
		const pages = await pool(candidates, 2, async (hit) => {
			throwIfAborted(opts.signal);
			if (hit.content && countWords(hit.content) >= 300) {
				return {
					title: hit.title,
					url: hit.url,
					domain: hostOf(hit.url),
					via: "search" as const,
					content: hit.content,
					wordCount: countWords(hit.content),
					fetchedAt: nowIso(),
					links: [] as string[],
				};
			}
			try {
				return await fetchPage(hit.url, { cache, signal: opts.signal, focus });
			} catch {
				throwIfAborted(opts.signal);
				return null;
			}
		});

		newDomainsThisRound = 0;
		const roundTitles: string[] = [];
		const roundDomains: string[] = [];
		for (let i = 0; i < candidates.length; i++) {
			const page = pages[i];
			if (!page) continue;
			const hit = candidates[i]!;
			seenUrls.add(hit.url);
			const domain = page.domain || hostOf(page.url) || hostOf(hit.url);
			if (!seenDomains.has(domain)) {
				seenDomains.add(domain);
				newDomainsThisRound++;
				roundDomains.push(domain);
			}
			const excerpts = pickExcerpts(page.content, focus, 3);
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
				freshCorroboratedBy: [],
			});
			if (sources.length >= maxSources) break;
		}

		stagnantDomainRounds = newDomainsThisRound === 0 ? stagnantDomainRounds + 1 : 0;
		applyCorroboration(sources, focus, isTimeSensitiveGoal(goal ?? query));
		const coverage = evaluateCoverage(query, goal, sources, newDomainsThisRound);
		const gaps = [...coverage.uncoveredTerms, ...coverage.uncoveredGoalTerms];
		const followups = suggestFollowups(focus, roundTitles, roundDomains, 4);
		if (gaps.length > 0) followups.unshift(`${query} ${gaps.join(" ")} evidence`);
		if (coverage.timeSensitiveGoal && goal) {
			followups.unshift(`${goal} ${new Date().getUTCFullYear()} official status`);
		}
		suggestedQueries = [...new Set(followups.map((q) => q.trim()).filter(Boolean))].slice(0, 4);
		if (suggestedQueries.length > 0) {
			nextQueries = suggestedQueries;
			if (round < maxRounds && mode !== "step") {
				progress(`round ${round}: evidence gaps -> ${suggestedQueries.join(" | ")}`);
			}
		}

		if (mode === "step") {
			stopReason = "step";
			break;
		}
		if (sources.length >= maxSources) {
			stopReason = "source_cap";
			break;
		}
		if (stagnantDomainRounds >= 2) {
			stopReason = "no_new_domains_two_rounds";
			break;
		}
		const queryCovered = coverage.uncoveredTerms.length === 0;
		if (queryCovered && coverage.goalEvidenceCovered && sources.length >= Math.min(3, maxSources)) {
			stopReason = goal ? "goal_evidence_covered" : "query_evidence_covered";
			break;
		}
		if (suggestedQueries.length === 0) {
			stopReason = "no_followups";
			break;
		}
	}

	applyCorroboration(sources, focus, isTimeSensitiveGoal(goal ?? query));
	const coverage = evaluateCoverage(query, goal, sources, newDomainsThisRound);
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
		corroborationMethod: "claim-segment lexical alignment plus exact version/date/measure anchors; heuristic, not proof",
	};
}
