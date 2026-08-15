/**
 * Shared utilities: fetch with timeout+signal, HTML entity decoding,
 * URL normalization, text tokenization, and a tiny concurrency pool.
 * Zero dependencies — node built-ins only.
 */

export const STOPWORDS = new Set([
	"the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
	"is", "are", "was", "were", "be", "been", "being", "this", "that", "these",
	"those", "it", "its", "as", "at", "by", "from", "up", "down", "out", "off",
	"over", "under", "again", "then", "than", "so", "too", "very", "can", "will",
	"just", "do", "does", "did", "have", "has", "had", "what", "which", "who",
	"whom", "when", "where", "why", "how", "all", "any", "both", "each", "few",
	"more", "most", "other", "some", "such", "no", "nor", "not", "only", "own",
	"same", "should", "about", "into", "through", "during", "before", "after",
	"above", "below", "between", "out", "if", "because", "until", "while",
]);

export interface FetchedText {
	ok: boolean;
	status: number;
	text: string;
	contentType?: string;
}

/** Fetch with external-signal + timeout support (node 20+: AbortSignal.any). */
export async function fetchText(
	url: string,
	opts: { timeoutMs?: number; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<FetchedText> {
	const timeoutMs = opts.timeoutMs ?? 15000;
	const signals = [opts.signal, AbortSignal.timeout(timeoutMs)].filter(
		(s): s is AbortSignal => s !== undefined && !s.aborted,
	);
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
	if (signals.length > 0) {
		signals[signals.length - 1].addEventListener("abort", () => controller.abort(), { once: true });
	}
	try {
		const res = await fetch(url, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
				Accept: "text/html,text/plain,application/json,*/*",
				...opts.headers,
			},
			signal: controller.signal,
			redirect: "follow",
		});
		return {
			ok: res.ok,
			status: res.status,
			text: await res.text(),
			contentType: res.headers.get("content-type") ?? undefined,
		};
	} finally {
		if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
	}
}

const ENTITY_MAP: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©",
	reg: "®", trade: "™", mdash: "—", ndash: "–", hellip: "…", rsquo: "’",
	ldquo: "“", rdquo: "”", middot: "·", bull: "•", laquo: "«", raquo: "»",
};

/** Decode common HTML entities (named + numeric). */
export function decodeHtml(input: string): string {
	return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent: string) => {
		if (ent.startsWith("#x") || ent.startsWith("#X")) {
			const cp = parseInt(ent.slice(2), 16);
			return Number.isNaN(cp) ? m : String.fromCodePoint(cp);
		}
		if (ent.startsWith("#")) {
			const cp = parseInt(ent.slice(1), 10);
			return Number.isNaN(cp) ? m : String.fromCodePoint(cp);
		}
		return ENTITY_MAP[ent] ?? m;
	});
}

/** Strip all HTML tags from a string. */
export function stripTags(input: string): string {
	return input.replace(/<[^>]*>/g, "");
}

/** Collapse whitespace runs. */
export function collapseSpace(input: string): string {
	return input.replace(/\s+/g, " ").trim();
}

/** Latin tokens (len >= 2, non-stopword). CJK runs are kept as whole tokens. */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	// CJK contiguous runs first
	const cjkRuns = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g) ?? [];
	for (const run of cjkRuns) out.push(run);
	// Latin/num tokens
	const words = text
		.toLowerCase()
		.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, " ")
		.match(/[a-z0-9][a-z0-9'._-]*/g) ?? [];
	for (const w of words) {
		if (w.length >= 2 && !STOPWORDS.has(w)) out.push(w);
	}
	return out;
}

/** Frequency-ranked distinctive terms of a text. */
export function distinctiveTerms(text: string, n: number): string[] {
	const counts = new Map<string, number>();
	for (const t of tokenize(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(([t]) => t);
}

/** Terms used for coverage scoring: latin tokens + whole CJK runs. */
export function queryTerms(query: string): string[] {
	return tokenize(query);
}

/** Normalize a URL for dedup: lower host, strip www./tracking params/trailing slash/hash. */
export function normalizeUrl(raw: string): string {
	try {
		const u = new URL(raw);
		u.hash = "";
		u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
		for (const key of [...u.searchParams.keys()]) {
			const k = key.toLowerCase();
			if (
				k.startsWith("utm_") || k === "fbclid" || k === "gclid" || k === "yclid" ||
				k === "ref" || k === "via" || k === "fpr" || k === "spm" || k === "_hsenc" ||
				k === "_hsmi" || k === "mc_cid" || k === "mc_eid" || k === "igshid" ||
				k === "pk" || k === "mtm_"
			) {
				u.searchParams.delete(key);
			}
		}
		let s = u.toString();
		if (s.endsWith("/")) s = s.slice(0, -1);
		return s;
	} catch {
		return raw.trim().replace(/[?#].*$/, "");
	}
}

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return "";
	}
}

/** domain equals pattern or is a subdomain of it (en.wikipedia.org matches wikipedia.org). */
export function domainMatches(domain: string, pattern: string): boolean {
	const d = domain.toLowerCase();
	const p = pattern.toLowerCase();
	return d === p || d.endsWith(`.${p}`);
}

export function decodeBingUrl(href: string): string {
	// Bing ck/a redirect URLs carry the real URL base64url-encoded in u=,
	// with a variable-length prefix (empirically "a1" or "a1a"). Try decoding
	// with 0/2/3-char prefixes and accept the first http(s) result.
	try {
		const u = new URL(href);
		const enc = u.searchParams.get("u");
		if (enc) {
			for (const skip of [0, 2, 3]) {
				let b64 = enc.slice(skip).replace(/-/g, "+").replace(/_/g, "/");
				while (b64.length % 4 !== 0) b64 += "=";
				try {
					const decoded = Buffer.from(b64, "base64").toString("utf8");
					if (decoded.startsWith("http")) return decoded;
				} catch {
					/* try next prefix */
				}
			}
		}
	} catch {
		/* fall through */
	}
	return href;
}

/** Run async tasks with bounded concurrency. */
export async function pool<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

export function nowIso(): string {
	return new Date().toISOString();
}
