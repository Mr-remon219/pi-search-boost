/**
 * Fused multi-engine search (step 1).
 *
 * Engines:
 *  - bing    : keyless HTML scraping (works without any API key; redirect URLs decoded)
 *  - tavily  : agent-designed search API (PI_SEARCH_TAVILY_KEY) — langchain-ai's default choice
 *  - exa     : neural/semantic search (PI_SEARCH_EXA_KEY)
 *  - brave   : keyword search with operators (PI_SEARCH_BRAVE_KEY)
 *
 * Fused search: query variants x engines in parallel, then URL-level dedupe
 * and cross-engine scoring (rank weight + cross-engine bonus + domain quality).
 */
import { JsonCache } from "./cache.ts";
import {
	collapseSpace, decodeBingUrl, decodeHtml, distinctiveTerms, domainMatches, fetchText,
	hostOf, normalizeUrl, pool, queryTerms, stripTags,
} from "./util.ts";

export interface SearchHit {
	title: string;
	url: string;
	domain: string;
	snippet: string;
	engines: string[];
	score: number;
	/** parsed publish date, e.g. "2026-08-16" (when the engine exposes it) */
	published?: string | null;
	/** full extracted text when the engine returns it (tavily/exa) — consumers
	 * can use it directly instead of fetching the page (GPT-Researcher pattern) */
	content?: string;
}

export interface EngineStats {
	[engine: string]: { used: boolean; cacheHits: number; errors: number; note?: string };
}

export interface FusedResult {
	query: string;
	queriesUsed: string[];
	results: SearchHit[];
	engineStats: EngineStats;
	cacheHits: number;
	tookMs: number;
	filters: { includeDomains: string[]; excludeDomains: string[]; recency?: string };
	/** complexity tier actually used (for audit/transparency) */
	tier: Complexity;
}

interface RawHit {
	title: string;
	url: string;
	snippet: string;
	/** raw date string from the engine, e.g. "2026年8月16日" */
	published?: string | null;
	/** full extracted content (tavily content / exa text) */
	content?: string;
}

function env(name: string): string | undefined {
	const v = process.env[name];
	return v && v.trim() !== "" ? v.trim() : undefined;
}

export const ENGINE_KEYS: Record<string, string> = {
	tavily: "PI_SEARCH_TAVILY_KEY",
	exa: "PI_SEARCH_EXA_KEY",
	brave: "PI_SEARCH_BRAVE_KEY",
};

export function availableEngines(): string[] {
	const list = ["bing"];
	if (env(ENGINE_KEYS.tavily)) list.push("tavily");
	if (env(ENGINE_KEYS.exa)) list.push("exa");
	if (env(ENGINE_KEYS.brave)) list.push("brave");
	return list;
}

/* ------------------------------ Complexity routing ----------------------------- */

/**
 * Complexity-aware routing (Keiro/Adaptive-RAG pattern): bind the search budget
 * to the query's complexity instead of paying the max for every query.
 *   simple  -> 1 variant x 2 engines (bing + tavily basic, 1 credit)
 *   medium  -> 2 variants x 3 engines (bing + tavily basic + brave)
 *   complex -> 3 variants x 4 engines (bing + tavily advanced + brave + exa, 2 credits)
 */
export type Complexity = "simple" | "medium" | "complex";

const RESEARCH_SIGNALS =
	/compare|comparison|comparative|versus|vs\.?|difference|architecture|design|implement|how to|why|what is the best|review|benchmark|survey|tutorial|guide|optimization|performance|最新|综述|对比|区别|架构|设计|实现|原理|怎么|如何|选型|方案/i;

export function estimateComplexity(query: string): Complexity {
	const tokens = queryTerms(query).length;
	if (RESEARCH_SIGNALS.test(query)) return "complex";
	if (tokens <= 2) return "simple";
	if (tokens <= 4) return "medium";
	return "complex";
}

const TIER_ENGINES: Record<Complexity, string[]> = {
	simple: ["bing", "tavily"],
	medium: ["bing", "tavily", "brave"],
	complex: ["bing", "tavily", "brave", "exa"],
};

const TIER_VARIANTS: Record<Complexity, number> = { simple: 1, medium: 2, complex: 3 };

/* ------------------------------ Query preprocessing ----------------------------- */

/**
 * Translate Grok-style queries (site:, -site:, "a" OR "b", quoted phrases)
 * into forms the keyless Bing HTML endpoint can actually use:
 *   - site:/ -site:  -> client-side include/exclude domain filters (Bing ignores these operators)
 *   - A OR B         -> split into separate query variants
 *   - quotes         -> stripped (Bing HTML mangles quoted queries)
 */
export interface ParsedQuery {
	/** query with operators/quotes removed, ready for the engines */
	cleaned: string;
	includeDomains: string[];
	excludeDomains: string[];
	/** alternatives from OR splits, each preprocessed recursively */
	alternatives: string[];
}

export function preprocessQuery(raw: string): ParsedQuery {
	let q = raw.trim();
	const includeDomains: string[] = [];
	const excludeDomains: string[] = [];
	// site: / -site: operators
	q = q.replace(/(?:^|\s)(-?)site:([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi, (_m, neg: string, d: string) => {
		(neg ? excludeDomains : includeDomains).push(d.toLowerCase());
		return " ";
	});
	// OR alternatives: "a" OR "b" / a OR b
	const alternatives: string[] = [];
	const orParts = q.split(/\s+OR\s+/i);
	if (orParts.length > 1) {
		q = orParts[0];
		for (const part of orParts.slice(1)) {
			const sub = preprocessQuery(part);
			alternatives.push(sub.cleaned, ...sub.alternatives);
			includeDomains.push(...sub.includeDomains);
			excludeDomains.push(...sub.excludeDomains);
		}
	}
	// strip quotes
	q = q.replace(/["“”]/g, " ").replace(/\s+/g, " ").trim();
	return {
		cleaned: q,
		includeDomains: [...new Set(includeDomains)],
		excludeDomains: [...new Set(excludeDomains)],
		alternatives: [...new Set(alternatives.filter((a) => a && a !== q))],
	};
}

/* ---------------------------------- Bing HTML ---------------------------------- */

/** Parse a Bing result date like "2026年8月16日" / "Aug 16, 2026" / "2026-08-16". */
export function parseDate(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const t = raw.trim();
	// Chinese: 2026年8月16日 / 2026年8月
	let m = /(\d{4})年(\d{1,2})月(\d{1,2})?日?/.exec(t);
	if (m) {
		const d = `${m[1]}-${m[2].padStart(2, "0")}-${m[3] ? m[3].padStart(2, "0") : "01"}`;
		return Number.isNaN(Date.parse(d)) ? null : d;
	}
	// English: Aug 16, 2026
	m = /([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/.exec(t);
	if (m) {
		const d = `${m[3]}-${(
			["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"
			].indexOf(m[1].slice(0, 3).toLowerCase()) +
			1
		).toString().padStart(2, "0")}-${m[2].padStart(2, "0")}`;
		return Number.isNaN(Date.parse(d)) ? null : d;
	}
	// ISO
	m = /(\d{4}-\d{2}-\d{2})/.exec(t);
	if (m) return m[1];
	return null;
}

async function searchBingHtml(query: string, count: number): Promise<RawHit[]> {
	const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`;
	const res = await fetchText(url, { timeoutMs: 15000 });
	if (!res.ok || res.text.length < 200) {
		throw new Error(`bing http ${res.status}`);
	}
	const html = res.text;
	// structure-change / bot-challenge detection: bing HTML has been stable for
	// years, but when it changes (or serves a challenge page) the parse yields
	// nothing while the HTTP status stays 200 — fail loudly instead of silently
	// returning empty results.
	if (/challenge-form|anomaly\.js|verify|captcha/i.test(html) && !/<li class="b_algo"/.test(html)) {
		throw new Error("bing: bot challenge page (structure/anti-bot changed)");
	}
	const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
	const blocks = html.match(blockRe) ?? [];
	if (blocks.length === 0) {
		throw new Error("bing: no result blocks parsed (HTML structure changed)");
	}
	if (blocks.length < Math.max(2, Math.floor(count / 3))) {
		// partial parse: possible structure drift; degrade gracefully but flag it
		throw new Error(`bing: parsed only ${blocks.length}/${count} blocks (possible structure change)`);
	}
	const hits: RawHit[] = [];
	for (const block of blocks) {
		if (hits.length >= count) break;
		const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
		if (!anchor) continue;
		const rawHref = anchor[1].replace(/&amp;/g, "&");
		const url2 = decodeBingUrl(rawHref);
		if (!/^https?:\/\//i.test(url2)) continue;
		const title = collapseSpace(decodeHtml(stripTags(anchor[2])));
		if (!title) continue;
		const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
		const snippet = p ? collapseSpace(decodeHtml(stripTags(p[1]))) : "";
		// publish date: bing puts it in <span class="news_dt"> or inline in the snippet
		const dt = /<span class="news_dt">([^<]*)<\/span>/i.exec(block);
		const published = dt ? dt[1].trim() : null;
		hits.push({ title, url: url2, snippet, published });
	}
	return hits;
}

/* ---------------------------------- Tavily ----------------------------------- */

const RECENCY_TO_PARAM: Record<string, { tavily: "day" | "week" | "month" | "year"; brave: "pd" | "pw" | "pm" | "py"; days: number }> = {
	day: { tavily: "day", brave: "pd", days: 1 },
	week: { tavily: "week", brave: "pw", days: 7 },
	month: { tavily: "month", brave: "pm", days: 30 },
	year: { tavily: "year", brave: "py", days: 365 },
};

export interface EngineQueryOptions {
	includeDomains?: string[];
	excludeDomains?: string[];
	recency?: "day" | "week" | "month" | "year";
	/** tavily search_depth: basic = fast NLP summary, advanced = query-aligned extraction */
	depth?: "basic" | "advanced";
}

async function searchTavily(query: string, count: number, o: EngineQueryOptions = {}): Promise<RawHit[]> {
	const key = env(ENGINE_KEYS.tavily)!;
	const body: Record<string, unknown> = {
		api_key: key,
		query,
		search_depth: o.depth ?? "basic",
		max_results: count,
		include_answer: false,
		include_raw_content: false,
	};
	// parameter-level domain filters and time range (native Tavily params —
	// no query-string translation needed)
	if (o.includeDomains?.length) body.include_domains = o.includeDomains.slice(0, 5);
	if (o.excludeDomains?.length) body.exclude_domains = o.excludeDomains.slice(0, 5);
	if (o.recency && RECENCY_TO_PARAM[o.recency]) body.time_range = RECENCY_TO_PARAM[o.recency].tavily;
	const resp = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20000),
	});
	if (!resp.ok) throw new Error(`tavily http ${resp.status}`);
	const json = (await resp.json()) as {
		results?: Array<{ title?: string; url?: string; content?: string }>;
	};
	return (json.results ?? [])
		.filter((r) => r.url)
		.slice(0, count)
		.map((r) => ({
			title: collapseSpace(r.title ?? ""),
			url: r.url!,
			// keep the full extracted text for direct consumption; snippet is the
			// first 240 chars for compact display
			snippet: collapseSpace(r.content ?? "").slice(0, 240),
			content: r.content,
		}));
}

/* ------------------------------------ Exa ------------------------------------- */

async function searchExa(query: string, count: number, o: EngineQueryOptions = {}): Promise<RawHit[]> {
	const key = env(ENGINE_KEYS.exa)!;
	const body: Record<string, unknown> = { query, numResults: count, contents: { text: false } };
	if (o.recency && RECENCY_TO_PARAM[o.recency]) {
		const days = RECENCY_TO_PARAM[o.recency].days;
		body.publishedAfter = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
	}
	const resp = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-api-key": key },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20000),
	});
	if (!resp.ok) throw new Error(`exa http ${resp.status}`);
	const json = (await resp.json()) as {
		results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string }>;
	};
	return (json.results ?? [])
		.filter((r) => r.url)
		.slice(0, count)
		.map((r) => ({
			title: collapseSpace(r.title ?? ""),
			url: r.url!,
			snippet: collapseSpace(r.text ?? ""),
			content: r.text,
		}));
}

/* ----------------------------------- Brave ------------------------------------ */

async function searchBrave(query: string, count: number, o: EngineQueryOptions = {}): Promise<RawHit[]> {
	const key = env(ENGINE_KEYS.brave)!;
	let url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`;
	if (o.recency && RECENCY_TO_PARAM[o.recency]) url += `&freshness=${RECENCY_TO_PARAM[o.recency].brave}`;
	const resp = await fetch(url, {
		headers: { "X-Subscription-Token": key, Accept: "application/json" },
		signal: AbortSignal.timeout(15000),
	});
	if (!resp.ok) throw new Error(`brave http ${resp.status}`);
	const json = (await resp.json()) as {
		web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
	};
	return (json.web?.results ?? [])
		.filter((r) => r.url)
		.slice(0, count)
		.map((r) => ({
			title: collapseSpace(r.title ?? ""),
			url: r.url!,
			snippet: collapseSpace(r.description ?? ""),
		}));
}

/* --------------------------------- Engine map --------------------------------- */

const ENGINE_FNS: Record<string, (q: string, n: number, o?: EngineQueryOptions) => Promise<RawHit[]>> = {
	bing: searchBingHtml,
	tavily: searchTavily,
	exa: searchExa,
	brave: searchBrave,
};

/* ------------------------------ Query expansion ------------------------------ */

const JUNK_DOMAINS = new Set([
	"pinterest.com", "pinterest.ca", "instagram.com", "facebook.com", "facebook.net",
	"tiktok.com", "linkedin.com", "x.com", "twitter.com", "youtube.com",
]);

const AUTHORITATIVE_TLDS = [".gov", ".edu", ".mil"];

/** Deterministic keyword-variant expansion (the "keyword search" step). */
export function expandQueries(query: string, site?: string): string[] {
	const clean = collapseSpace(query);
	const variants = new Set<string>();
	variants.add(clean);
	// NOTE: no quoted-phrase variant — engines treat "q" and q as near-identical
	// (measured 100% token overlap), so it only doubles the request count.
	// keyword terms from the query itself
	const terms = queryTerms(clean).filter((t) => t.length >= 3).slice(0, 4);
	if (terms.length >= 2) variants.add(terms.slice(0, 2).join(" "));
	if (terms.length >= 3) variants.add(terms.slice(0, 3).join(" "));
	// CJK: split each contiguous run into 2-char chunks (natural Chinese keyword units)
	const cjkRuns = clean.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
	for (const run of cjkRuns) {
		const chunks: string[] = [];
		for (let i = 0; i < run.length; i += 2) chunks.push(run.slice(i, i + 2));
		if (chunks.length >= 2) variants.add(chunks.join(" "));
	}
	// site-restricted variant
	if (site) {
		variants.add(`site:${site} ${clean}`);
	}
	return [...variants].slice(0, 4);
}

/* --------------------------------- Scoring ----------------------------------- */

const ENGINE_WEIGHT: Record<string, number> = { bing: 1.0, tavily: 1.2, exa: 1.2, brave: 1.1 };

function domainBonus(domain: string): number {
	if (AUTHORITATIVE_TLDS.some((t) => domain.endsWith(t))) return 0.6;
	if (domain === "wikipedia.org" || domain === "github.com") return 0.4;
	if (JUNK_DOMAINS.has(domain)) return -0.5;
	return 0;
}

/* ------------------------------- Fused search -------------------------------- */

export interface FusedOptions {
	query: string;
	queries?: string[];
	engines?: string[];
	maxResults?: number;
	maxPerEngine?: number;
	/** max results per domain in the fused output (default 2) */
	maxPerDomain?: number;
	/** only keep results from these domains (Bing ignores site: operators, so this is a hard client-side filter) */
	includeDomains?: string[];
	/** drop results from these domains (hard client-side filter) */
	excludeDomains?: string[];
	/** recency window; older results decay exponentially (default "any") */
	recency?: "day" | "week" | "month" | "year" | "any";
	/** drop results below this fused score floor (Grok's min_score, default 0) */
	minScore?: number;
	/** tavily search depth: basic (fast) or advanced (query-aligned content, for direct consumption) */
	depth?: "basic" | "advanced";
	/** complexity tier: auto (heuristic) or explicit; controls engines/variants/depth */
	complexity?: "auto" | "simple" | "medium" | "complex";
	/** deprecated alias for includeDomains */
	site?: string;
	cache?: JsonCache;
	signal?: AbortSignal;
	progress?: (msg: string) => void;
}

export async function fusedSearch(opts: FusedOptions): Promise<FusedResult> {
	const started = Date.now();
	// complexity tier: explicit wins, otherwise heuristic (Keiro-style routing)
	const tier: Complexity = opts.complexity === "auto" || !opts.complexity
		? estimateComplexity(opts.query)
		: opts.complexity;
	// engine set per tier: only keyed engines that are actually configured are kept
	const available = availableEngines();
	const engines = (opts.engines ?? TIER_ENGINES[tier]).filter(
		(e) => ENGINE_FNS[e] && available.includes(e),
	);
	// depth: advanced only pays 2x credits when content will actually be consumed
	const depth = opts.depth ?? (tier === "complex" ? "advanced" : "basic");
	const cache = opts.cache;
	// preprocess all raw queries (Grok-style site:/OR/quotes -> client filters + variants)
	const rawQueries = opts.queries && opts.queries.length > 0 ? opts.queries : [opts.query];
	const parsed = rawQueries.map(preprocessQuery);
	const queryForExpansion = parsed.map((p) => p.cleaned).filter(Boolean).join(" ") || opts.query;
	const includeDomains = [
		...(opts.includeDomains ?? (opts.site ? [opts.site] : [])),
		...parsed.flatMap((p) => p.includeDomains),
	].map((d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, ""));
	const excludeDomains = [
		...(opts.excludeDomains ?? []),
		...parsed.flatMap((p) => p.excludeDomains),
	].map((d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, ""));
	const queries = [...new Set([
		...parsed.flatMap((p) => [p.cleaned, ...p.alternatives]),
		...expandQueries(queryForExpansion),
	].filter(Boolean))].slice(0, TIER_VARIANTS[tier] + (includeDomains.length > 0 ? 2 : 0));
	// guard: a degenerate query (all punctuation/operators) must still search
	if (queries.length === 0) queries.push(opts.query);
	// include-domain queries: bing ignores site:, so each include domain gets its
	// own parallel query pass and the results are client-filtered below.
	const effectiveQueries = includeDomains.length > 0
		? [...new Set([...queries, ...includeDomains.map((d) => `${opts.query} ${d}`)])].slice(0, 6)
		: queries;
	const maxPerEngine = opts.maxPerEngine ?? Math.max(4, Math.ceil((opts.maxResults ?? 10) * 0.75));
	const cacheTtl = Number(process.env.PI_SEARCH_CACHE_TTL ?? 21600); // 6h

	const engineStats: EngineStats = {};
	for (const e of engines) engineStats[e] = { used: true, cacheHits: 0, errors: 0 };

	// engine x query tasks, cached per (engine, query)
	// Adaptive pruning: run the first 2 query variants first; only fire the rest
	// if the fused pool looks thin (performance: ~40% fewer search requests).
	const tasks: Array<{ engine: string; query: string }> = [];
	for (const e of engines) for (const q of effectiveQueries) tasks.push({ engine: e, query: q });
	const primary = tasks.filter((t) => effectiveQueries.indexOf(t.query) < 2);
	const secondary = tasks.filter((t) => effectiveQueries.indexOf(t.query) >= 2);

	const perEngineHits = new Map<string, RawHit[]>();
	let cacheHits = 0;
	// parameter-level engine options: native domain filters + time range on
	// tavily/brave/exa (keyed engines) instead of query-string translation
	const engineOpts: EngineQueryOptions = {
		includeDomains: includeDomains.length > 0 ? includeDomains : undefined,
		excludeDomains: excludeDomains.length > 0 ? excludeDomains : undefined,
		recency: opts.recency !== "any" ? opts.recency : undefined,
		depth,
	};

	async function runBatch(batch: Array<{ engine: string; query: string }>) {
		await pool(batch, 5, async ({ engine, query }) => {
			const key = `search:${engine}:${query.toLowerCase()}`;
			const cached = cache?.get<RawHit[]>(key);
			if (cached) {
				cacheHits++;
				engineStats[engine].cacheHits++;
				perEngineHits.set(`${engine}\u0000${query}`, cached);
				return;
			}
			try {
				const hits = await ENGINE_FNS[engine](query, maxPerEngine, engineOpts);
				cache?.set(key, hits, cacheTtl);
				perEngineHits.set(`${engine}\u0000${query}`, hits);
			} catch (err) {
				engineStats[engine].errors++;
				engineStats[engine].note = err instanceof Error ? err.message.slice(0, 80) : String(err);
				perEngineHits.set(`${engine}\u0000${query}`, []);
			}
		});
	}

	await runBatch(primary);

	// thin-pool check: fused unique hits from the primary batch.
	// Threshold is deliberately loose (0.4x): only fire the second wave when the
	// pool is genuinely thin, so the common case is a single parallel wave.
	const primaryPool = new Set<string>();
	for (const { engine, query } of primary) {
		for (const hit of perEngineHits.get(`${engine}\u0000${query}`) ?? []) {
			const norm = normalizeUrl(hit.url);
			if (norm.startsWith("http")) primaryPool.add(norm);
		}
	}
	const maxResults = opts.maxResults ?? 10;
	if (primaryPool.size < Math.max(3, Math.round(maxResults * 0.4)) && secondary.length > 0) {
		await runBatch(secondary);
	}

	// fusion: dedupe by normalized URL, score
	const merged = new Map<string, SearchHit>();
	for (const { engine, query } of tasks) {
		const hits = perEngineHits.get(`${engine}\u0000${query}`) ?? [];
		hits.forEach((hit, rank) => {
			const norm = normalizeUrl(hit.url);
			if (!norm.startsWith("http")) return;
			const domain = hostOf(norm);
			if (!domain) return;
			// hard filters (client-side; bing ignores site:/-site: operators)
			if (excludeDomains.some((d) => domainMatches(domain, d))) return;
			if (includeDomains.length > 0 && !includeDomains.some((d) => domainMatches(domain, d))) return;
			const existing = merged.get(norm);
			const score = ENGINE_WEIGHT[engine] * Math.max(0, 1 - rank / 10);
			const published = hit.published ? parseDate(hit.published) : null;
			if (existing) {
				if (!existing.engines.includes(engine)) existing.engines.push(engine);
				existing.score += score;
				if (rank === 0) existing.snippet = existing.snippet || hit.snippet;
				if (existing.published == null && published) existing.published = published;
				// keep the richest content across engines for direct consumption
				if (hit.content && (!existing.content || hit.content.length > existing.content.length)) {
					existing.content = hit.content;
				}
			} else {
				merged.set(norm, {
					title: hit.title || norm,
					url: norm,
					domain,
					snippet: hit.snippet,
					engines: [engine],
					score,
					published,
					content: hit.content,
				});
			}
		});
	}

	// recency: half-life exponential decay (learned from Grok Build's memory search:
	// temporal_decay.half_life_days — smooth decay instead of hard thresholds).
	// half-life scales with the window: day->0.5d, week->3d, month->15d, year->90d
	const RECENCY_HALF_LIFE_DAYS: Record<string, number> = {
		day: 0.5, week: 3, month: 15, year: 90,
	};
	const halfLifeMs = opts.recency
		? RECENCY_HALF_LIFE_DAYS[opts.recency] * 86400000
		: undefined;
	const RECENCY_BONUS = 0.6;

	// include mode wants more per-domain depth
	const maxPerDomain = opts.maxPerDomain ?? (includeDomains.length > 0 ? Math.max(2, maxResults) : 2);
	const relTerms = queryTerms(opts.query);
	// relevance: bonus per query term found in title/snippet; penalty if none
	const results = [...merged.values()]
		.map((r) => {
			const cross = Math.min(2.4, (r.engines.length - 1) * 0.8);
			const hay = `${r.title} ${r.snippet}`.toLowerCase();
			let termHits = 0;
			for (const t of relTerms) {
				if (t.length >= 2 && hay.includes(t.toLowerCase())) termHits++;
			}
			const rel = termHits > 0 ? Math.min(termHits, 3) * 0.25 : -0.6;
			// recency: exponential half-life decay (Grok-style temporal_decay).
			// dated: bonus = 0.6 * 0.5^(age/halfLife); undated: small neutral penalty.
			let rec = 0;
			if (halfLifeMs !== undefined) {
				if (r.published) {
					const t = Date.parse(r.published);
					if (!Number.isNaN(t)) {
						const ageMs = Date.now() - t;
						rec = ageMs > 0 ? RECENCY_BONUS * Math.pow(0.5, ageMs / halfLifeMs) : RECENCY_BONUS;
					} else {
						rec = -0.1;
					}
				} else {
					rec = -0.1;
				}
			}
			return { ...r, score: Math.round((r.score + cross + rel + rec + domainBonus(r.domain)) * 100) / 100 };
		})
		.sort((a, b) => b.score - a.score);
	// per-domain cap: keep the highest-scoring hits per domain; drop noise
	// below min_score (Grok's min_score threshold, 0.35 there; default 0 here).
	const minScore = opts.minScore ?? 0;
	const perDomain = new Map<string, number>();
	const capped: typeof results = [];
	for (const r of results) {
		if (r.score < minScore) continue;
		const n = perDomain.get(r.domain) ?? 0;
		if (n >= maxPerDomain) continue;
		perDomain.set(r.domain, n + 1);
		capped.push(r);
		if (capped.length >= maxResults) break;
	}
	return {
		query: opts.query,
		queriesUsed: effectiveQueries,
		results: capped,
		engineStats,
		cacheHits,
		tookMs: Date.now() - started,
		filters: { includeDomains, excludeDomains, recency: opts.recency },
		tier,
	};
}

/** Follow-up query suggestions from fetched material (used by deep_research). */
export function suggestFollowups(query: string, titles: string[], newDomains: string[], n = 4): string[] {
	const out: string[] = [];
	// terms already in the query are useless as follow-up additions
	const queryTermsSet = new Set(queryTerms(query));
	for (const t of titles) {
		for (const term of distinctiveTerms(t, 2)) {
			if (term.length >= 3 && !queryTermsSet.has(term)) out.push(`${query} ${term}`);
		}
	}
	for (const d of newDomains) {
		if (AUTHORITATIVE_TLDS.some((s) => d.endsWith(s)) || d === "wikipedia.org") {
			out.push(`site:${d} ${query}`);
		}
	}
	return [...new Set(out)].slice(0, n);
}
