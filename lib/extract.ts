/**
 * Page fetching + reader-mode extraction (step 2).
 *
 * Primary: Jina Reader (https://r.jina.ai/<url>) — keyless markdown extraction,
 * the same approach used by OpenDeepResearcher. Returns clean Markdown with
 * "Title:" / "URL Source:" headers.
 *
 * Fallback: local heuristic extraction (strip scripts/nav, block->newlines).
 */
import { JsonCache } from "./cache.ts";
import {
	assertPublicHttpUrl, collapseSpace, countWords, decodeHtml, fetchText, hostOf, nowIso, queryTerms, stripTags,
} from "./util.ts";

export interface PageResult {
	title: string;
	url: string;
	domain: string;
	fetchedAt: string;
	via: "jina" | "local" | "cache" | "jina-browser" | "search";
	content: string;
	wordCount: number;
	links: string[];
	/** why jina failed (if it did) — for audit */
	jinaError?: string;
	/** why the local extractor failed (if it did) */
	localError?: string;
	/** true when focus filtering trimmed the content (dynamic filtering) */
	focused?: boolean;
	/** characters removed by focus filtering */
	filteredChars?: number;
}

const DEFAULT_MAX_CHARS = 12000;

/* --------------------------------- Jina Reader -------------------------------- */

async function fetchViaJina(
	url: string,
	signal: AbortSignal | undefined,
	opts: { engine?: "default" | "browser" } = {},
): Promise<{ title: string; content: string }> {
	const headers: Record<string, string> = {
		"X-Return-Format": "markdown",
		// Jina returns 403 for browser-like User-Agents; a neutral UA works (verified).
		"User-Agent": "curl/8.5.0",
	};
	if (opts.engine === "browser") {
		headers["X-Engine"] = "browser";
		headers["X-Timeout"] = "20";
	} else {
		headers["X-Timeout"] = "15";
	}
	const res = await fetchText(`https://r.jina.ai/${url}`, {
		timeoutMs: opts.engine === "browser" ? 25000 : 20000,
		signal,
		headers,
	});
	// performance: rate limits fail fast — the local fallback is faster than
	// waiting out a 429 retry storm under parallel fetches.
	if (!res.ok) throw new Error(`jina http ${res.status}`);
	let text = res.text;
	// Jina response format: "Title: ...\nURL Source: ...\nMarkdown Content:\n..."
	const titleMatch = /^Title:\s*(.+)$/m.exec(text);
	const title = titleMatch ? collapseSpace(titleMatch[1]) : "";
	const contentIdx = text.indexOf("Markdown Content:");
	const content = contentIdx >= 0 ? text.slice(contentIdx + "Markdown Content:".length) : text;
	if (!content.trim()) throw new Error("jina empty content");
	return { title: title || url, content: content.trim() };
}

/* ------------------------------ Local extraction ------------------------------ */

function localExtract(html: string): { title: string; content: string; links: string[] } {
	let title = "";
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (titleMatch) title = collapseSpace(decodeHtml(stripTags(titleMatch[1])));
	const ogMatch = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
	if (ogMatch && !title) title = collapseSpace(decodeHtml(ogMatch[1]));

	// collect outbound links (unique domains)
	const links = new Set<string>();
	for (const m of html.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["']/gi)) {
		const d = hostOf(m[1]);
		if (d) links.add(d);
	}

	let body = html
		// remove non-content blocks first
		.replace(/<(script|style|noscript|svg|iframe|form|nav|footer|header|aside|button|select|option)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		// block elements -> paragraph breaks
		.replace(/<(p|div|section|article|h[1-6]|table|tr|blockquote|li)[^>]*>/gi, "\n")
		.replace(/<\/(p|div|section|article|h[1-6]|table|tr|blockquote|li|ul|ol)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<li[^>]*>/gi, "\n- ")
		// strip remaining tags
		.replace(/<[^>]*>/g, " ");
	body = decodeHtml(body);
	// split into lines, drop nav-like junk (short lines containing links or pure punctuation)
	const lines = body
		.split(/\n+/)
		.map((l) => collapseSpace(l))
		.filter((l) => {
			if (l.length < 24) return false;
			if (l.length < 60 && /https?:\/\//i.test(l)) return false;
			return true;
		});
	let content = lines.join("\n\n");
	if (content.length > 80000) content = content.slice(0, 80000);
	return { title: title || "", content, links: [...links].slice(0, 12) };
}

/* ---------------------------------- Public API --------------------------------- */

export interface FetchPageOptions {
	maxChars?: number;
	/** focus terms: when provided, only query-relevant paragraphs are returned
	 * (Grok's find_in_page / Anthropic dynamic-filtering pattern) — the rest is
	 * filtered out before it reaches the context window */
	focus?: string;
	cache?: JsonCache;
	signal?: AbortSignal;
	progress?: (msg: string) => void;
}

export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<PageResult> {
	await assertPublicHttpUrl(url);
	const cache = opts.cache;
	const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
	const cacheTtl = Number(process.env.PI_SEARCH_PAGE_TTL ?? 86400); // 24h

	const cached = cache?.get<PageResult>(`page:${url}`);
	if (cached) {
		// cache stores the UNfiltered content; focus filtering is applied live on
		// every read, so any focus (or none) can reuse the same cache entry
		let content = cached.content;
		let focused = false;
		let filteredChars = 0;
		if (opts.focus) {
			const relevant = pickParagraphs(content, opts.focus, 8, 400);
			const relevantText = relevant.join("\n\n");
			if (relevantText.length > 0 && relevantText.length < content.length * 0.6) {
				filteredChars = content.length - relevantText.length;
				content = relevantText;
				focused = true;
			}
		}
		const truncate = (t: string) => {
			const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
			if (t.length <= maxChars) return t;
			const cut = t.slice(0, maxChars);
			const boundary = cut.lastIndexOf("\n\n");
			return (boundary > maxChars * 0.6 ? cut.slice(0, boundary) : cut) + "\n\n[truncated]";
		};
		return {
			...cached,
			content: truncate(content),
			wordCount: countWords(truncate(content)),
			focused,
			filteredChars,
			via: "cache",
		};
	}

	interface RaceResult {
		ok: boolean;
		via: "jina" | "local";
		title: string;
		content: string;
		links?: string[];
		error?: string;
	}
	const words = countWords;

	// Race the two fetch channels (jina ~1s, local ~1-2s) instead of running them
	// serially — eliminates the 20s+10s worst-case stacking measured in the field.
	const localCtrl = new AbortController();
	const localSignal = opts.signal ? AbortSignal.any([opts.signal, localCtrl.signal]) : localCtrl.signal;

	const jinaP: Promise<RaceResult> = fetchViaJina(url, opts.signal).then(
		(j) => ({ ok: true, via: "jina", title: j.title, content: j.content }),
		(err) => ({
			ok: false, via: "jina", title: "", content: "",
			error: err instanceof Error ? err.message : String(err),
		}),
	);
	const localP: Promise<RaceResult> = fetchText(url, { timeoutMs: 10000, signal: localSignal }).then(
		(res) => {
			if (!res.ok) return { ok: false, via: "local", title: "", content: "", error: `http ${res.status}` };
			const ext = localExtract(res.text);
			return { ok: true, via: "local", title: ext.title, content: ext.content, links: ext.links };
		},
		(err) => ({
			ok: false, via: "local", title: "", content: "",
			error: err instanceof Error ? err.message : String(err),
		}),
	);

	const waitFor = <T>(p: Promise<T>, ms: number): Promise<T | null> => {
		let timer: ReturnType<typeof setTimeout>;
		const timeoutP = new Promise<T | null>((resolve) => {
			timer = setTimeout(() => resolve(null), ms);
			timer.unref?.(); // don't keep the process alive for a race timeout
		});
		return Promise.race([p, timeoutP]);
	};

	const first = await Promise.race([jinaP, localP]);
	const other = first.via === "jina" ? localP : jinaP;

	let title = "";
	let content = "";
	let via: PageResult["via"] = "local";
	let jinaError: string | undefined;
	let localError: string | undefined;
	const links: string[] = [];

	const adopt = (r: RaceResult) => {
		title = r.title;
		content = r.content;
		via = r.via;
		if (r.links) links.push(...r.links);
	};

	// Balance: pure racing lets the (lower-quality) local channel win too often.
	// Instead: jina is preferred, but only within a grace window — if it hasn't
	// finished in JINA_GRACE_MS, adopt whatever local produced (no serial
	// stacking of timeouts). 2.5s covers typical fast jina responses (0.6-2s);
	// slower jina responses fall back to local rather than blocking.
	const JINA_GRACE_MS = 2500;
	if (first.via === "jina" && first.ok && words(first.content) >= 300) {
		// fast path: jina won outright with solid content
		localCtrl.abort();
		adopt(first);
	} else if (first.via === "local" && first.ok && words(first.content) >= 200) {
		// local won — give jina a grace period to produce better content
		const jina = await waitFor(jinaP, JINA_GRACE_MS);
		if (jina && jina.ok && words(jina.content) >= 300) {
			adopt(jina);
		} else {
			adopt(first);
		}
	} else if (first.via === "jina" && first.ok) {
		// jina won but thin: wait briefly for local, keep the bigger
		const second = await waitFor(other, 2500);
		if (second && second.ok && words(second.content) > words(first.content)) adopt(second);
		else adopt(first);
	} else if (first.via === "local" && first.ok) {
		// local won but thin: wait for jina (grace), keep the bigger
		const jina = await waitFor(jinaP, JINA_GRACE_MS);
		if (jina && jina.ok && words(jina.content) > words(first.content)) adopt(jina);
		else adopt(first);
	} else {
		// first channel failed: wait for the other (bounded), then record the error
		const second = await waitFor(other, 3000);
		if (second && second.ok) adopt(second);
		if (first.via === "jina") jinaError = first.error;
		else localError = first.error;
	}

	// thin-content enhancement: both channels gave a skeleton (<300 words) —
	// try the headless-browser engine once (bounded 15s), keep the larger version
	if (content && words(content) < 300) {
		try {
			const jb = await fetchViaJina(url, opts.signal, { engine: "browser" });
			if (words(jb.content) > words(content)) {
				title = jb.title;
				content = jb.content;
				via = "jina-browser";
			}
		} catch (err) {
			jinaError = `${jinaError ?? ""}; browser: ${err instanceof Error ? err.message : String(err)}`.trim();
		}
	}

	// last resort: browser engine when both channels failed outright
	if (!content) {
		try {
			const j = await fetchViaJina(url, opts.signal, { engine: "browser" });
			adopt({ ok: true, via: "jina", title: j.title, content: j.content });
			via = "jina-browser";
		} catch (err) {
			jinaError = `${jinaError ?? ""}; browser: ${err instanceof Error ? err.message : String(err)}`.trim();
		}
	}
	if (!content) {
		throw new Error(
			`failed to extract content from ${url} (jina: ${jinaError ?? "n/a"}${localError ? `, local: ${localError}` : ""})`,
		);
	}

	// store the UNfiltered content so later requests with any focus (or none)
	// can reuse this entry — focus filtering happens on read, not write
	const rawResult: PageResult = {
		title: title || url,
		url,
		domain: hostOf(url),
		fetchedAt: nowIso(),
		via,
		content,
		wordCount: countWords(content),
		links,
		jinaError,
		localError,
	};
	cache?.set(`page:${url}`, rawResult, cacheTtl);

	// dynamic filtering (Grok find_in_page / Anthropic pattern): when a focus is
	// given, keep only query-relevant paragraphs; the rest never hits the context
	let focused = false;
	let filteredChars = 0;
	if (opts.focus) {
		const relevant = pickParagraphs(content, opts.focus, 8, 400);
		const relevantText = relevant.join("\n\n");
		if (relevantText.length > 0 && relevantText.length < content.length * 0.6) {
			filteredChars = content.length - relevantText.length;
			content = relevantText;
			focused = true;
		}
	}

	// truncate at paragraph boundary near maxChars
	let truncated = content;
	if (truncated.length > maxChars) {
		const cut = truncated.slice(0, maxChars);
		const boundary = cut.lastIndexOf("\n\n");
		truncated = boundary > maxChars * 0.6 ? cut.slice(0, boundary) : cut;
		truncated += "\n\n[truncated]";
	}

	const result: PageResult = {
		title: title || url,
		url,
		domain: hostOf(url),
		fetchedAt: nowIso(),
		via,
		content: truncated,
		wordCount: countWords(truncated),
		links,
		jinaError,
		localError,
		focused,
		filteredChars,
	};
	return result;
}

/** Reader-mode markdown keeps navigation as dense link lists; those lines
 * match query terms as readily as prose and are worthless as evidence. */
function isBoilerplate(text: string): boolean {
	const linkChars = (text.match(/\]\(|https?:\/\/|!\[/g) ?? []).length;
	if (linkChars >= 3) return true;
	const urlChars = (text.match(/https?:\/\/\S+/g) ?? []).join("").length;
	return urlChars > text.length * 0.35;
}

function termMatchers(text: string): Array<{ re: RegExp; weight: number }> {
	return queryTerms(text)
		.filter((t) => t.length >= 2)
		.map((t) => ({
			re: new RegExp(t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
			weight: Math.min(t.length, 12),
		}));
}

function scoreAgainstTerms(text: string, matchers: ReturnType<typeof termMatchers>): number {
	const lower = text.toLowerCase();
	let score = 0;
	for (const { re, weight } of matchers) {
		re.lastIndex = 0;
		score += (lower.match(re)?.length ?? 0) * weight;
	}
	return score;
}

/**
 * Paragraphs most relevant to the focus terms (dynamic filtering, find_in_page).
 * Length floors are counted in words, not characters: a 40-character Chinese
 * paragraph was previously discarded before it could be scored.
 */
export function pickParagraphs(content: string, focus: string, max = 8, maxLen = 400): string[] {
	const matchers = termMatchers(focus);
	return content
		.split(/\n{2,}/)
		.map((p) => collapseSpace(p))
		.filter((p) => countWords(p) >= 8 && !isBoilerplate(p))
		.map((p) => ({ p, score: scoreAgainstTerms(p, matchers) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, max)
		.map((x) => x.p.slice(0, maxLen));
}

/** Pick the sentences of a page most relevant to the query (for excerpts/corroboration). */
export function pickExcerpts(content: string, query: string, max = 3, maxLen = 500): string[] {
	const matchers = termMatchers(query);
	const scored = content
		.split(/(?<=[.!?。！？])\s+|\n{2,}/)
		.map((s) => collapseSpace(s))
		.filter((s) => countWords(s) >= 12 && !isBoilerplate(s))
		.map((s) => ({ s, score: scoreAgainstTerms(s, matchers) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, max);
	if (scored.length === 0) {
		return [collapseSpace(content).slice(0, maxLen)];
	}
	return scored.map((x) => x.s.slice(0, maxLen));
}

/** Truncate engine-provided page text for the fused_search tool payload. */
export function excerptForTool(content: string, maxChars = 2000): string {
	const t = content.trim();
	if (t.length <= maxChars) return t;
	const cut = t.slice(0, maxChars);
	const boundary = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf("\n"));
	return (boundary > maxChars * 0.6 ? cut.slice(0, boundary) : cut) + "\n[content truncated]";
}
