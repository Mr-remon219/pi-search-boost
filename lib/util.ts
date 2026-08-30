/**
 * Shared utilities: fetch with timeout+signal, HTML entity decoding,
 * URL normalization, text tokenization, and a tiny concurrency pool.
 * Zero dependencies — node built-ins only.
 */
import { lookup as lookupPromise } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

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
	finalUrl?: string;
}

/** Combine caller cancellation with a timeout, preserving the first abort reason. */
export function signalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	if (!signal) return timeout;
	if (signal.aborted) return signal;
	if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
	const controller = new AbortController();
	const inputs = [signal, timeout];
	const cleanup = () => inputs.forEach((s) => s.removeEventListener("abort", onAbort));
	const onAbort = (event: Event) => {
		cleanup();
		const source = event.target as AbortSignal;
		controller.abort(source.reason);
	};
	inputs.forEach((s) => s.addEventListener("abort", onAbort, { once: true }));
	return controller.signal;
}

/** Throw consistently when the caller cancelled an operation. */
export function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new Error("aborted");
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_PUBLIC_FETCH_BYTES = 5 * 1024 * 1024;

interface PublicResponse {
	status: number;
	text: string;
	contentType?: string;
	location?: string;
}

/**
 * GET an untrusted public URL through node:http(s) with a guarded lookup
 * callback. The address approved by the guard is the address the socket uses,
 * closing the DNS check/connect rebinding gap while retaining Host/SNI.
 */
async function requestPublicText(
	rawUrl: string,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<PublicResponse> {
	const { url } = parsePublicHttpUrl(rawUrl);
	const lookup = (
		hostname: string,
		options: { family?: number; all?: boolean },
		callback: (error: NodeJS.ErrnoException | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void,
	) => {
		resolvePublicAddresses(hostname, signal).then(
			(addresses) => {
				const requested = options?.family;
				const candidates = requested ? addresses.filter((entry) => entry.family === requested) : addresses;
				const selected = candidates[0] ?? addresses[0];
				if (!selected) {
					callback(Object.assign(new Error("blocked url: cannot resolve host"), { code: "ENOTFOUND" }));
					return;
				}
				if (options?.all) callback(null, candidates.length > 0 ? candidates : addresses);
				else callback(null, selected.address, selected.family);
			},
			(error) => callback(error as NodeJS.ErrnoException),
		);
	};
	return new Promise<PublicResponse>((resolve, reject) => {
		const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
		const req = requester(url, { method: "GET", headers, signal, lookup: lookup as never }, (res) => {
			const chunks: Buffer[] = [];
			let bytes = 0;
			let settled = false;
			res.on("data", (chunk: Buffer | string) => {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				bytes += buffer.length;
				if (bytes > MAX_PUBLIC_FETCH_BYTES) {
					settled = true;
					res.destroy(new Error(`response too large (>${MAX_PUBLIC_FETCH_BYTES} bytes)`));
					return;
				}
				chunks.push(buffer);
			});
			res.on("end", () => {
				if (settled) return;
				settled = true;
				resolve({
					status: res.statusCode ?? 0,
					text: Buffer.concat(chunks).toString("utf8"),
					contentType: typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : undefined,
					location: typeof res.headers.location === "string" ? res.headers.location : undefined,
				});
			});
			res.on("error", (error) => {
				if (!settled) reject(error);
			});
		});
		req.on("error", reject);
		req.end();
	});
}

/**
 * Fetch text with caller cancellation and a timeout. Untrusted page URLs use a
 * DNS-pinned node:http(s) transport and manually validated redirects; trusted
 * fixed service endpoints retain standard fetch behavior.
 */
export async function fetchText(
	url: string,
	opts: {
		timeoutMs?: number;
		headers?: Record<string, string>;
		signal?: AbortSignal;
		publicRedirects?: boolean;
		maxRedirects?: number;
	} = {},
): Promise<FetchedText> {
	const signal = signalWithTimeout(opts.signal, opts.timeoutMs ?? 15000);
	const headers: Record<string, string> = {
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
		Accept: "text/html,text/plain,application/json,*/*",
		...opts.headers,
	};
	if (!opts.publicRedirects) {
		const res = await fetch(url, { headers, signal, redirect: "follow" });
		return {
			ok: res.ok,
			status: res.status,
			text: await res.text(),
			contentType: res.headers.get("content-type") ?? undefined,
			finalUrl: res.url || url,
		};
	}

	let currentUrl = url;
	const maxRedirects = Math.min(10, Math.max(0, opts.maxRedirects ?? 5));
	for (let redirects = 0; ; redirects++) {
		throwIfAborted(signal);
		const res = await requestPublicText(currentUrl, headers, signal);
		if (!REDIRECT_STATUSES.has(res.status)) {
			return {
				ok: res.status >= 200 && res.status < 300,
				status: res.status,
				text: res.text,
				contentType: res.contentType,
				finalUrl: currentUrl,
			};
		}
		if (redirects >= maxRedirects) throw new Error(`too many redirects (>${maxRedirects})`);
		if (!res.location) {
			return { ok: false, status: res.status, text: res.text, contentType: res.contentType, finalUrl: currentUrl };
		}
		currentUrl = await validatePublicRedirect(currentUrl, res.location, signal);
	}
}

/** Resolve a redirect Location and apply the same public-network policy. */
export async function validatePublicRedirect(
	currentUrl: string,
	location: string,
	signal?: AbortSignal,
): Promise<string> {
	let nextUrl: string;
	try {
		nextUrl = new URL(location, currentUrl).toString();
	} catch {
		throw new Error("blocked redirect: invalid Location URL");
	}
	await assertPublicHttpUrl(nextUrl, signal);
	return nextUrl;
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

/** Characters that whitespace tokenization cannot split: CJK + kana + hangul. */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const CJK_CHAR_G = new RegExp(CJK_CHAR.source, "g");
const CJK_RUN_G = new RegExp(`${CJK_CHAR.source}{2,}`, "g");

/** Chinese particles that dominate segmenter output and wreck coverage scoring. */
const CJK_STOPWORDS = new Set([
	"的", "了", "和", "是", "在", "有", "与", "及", "或", "对", "把", "被", "从", "到",
	"为", "以", "而", "并", "也", "还", "就", "都", "很", "更", "最", "个", "中", "上",
	"下", "这", "那", "什么", "怎么", "如何", "为什么", "哪些", "可以", "使用", "一个",
	"我们", "他们", "它", "吗", "呢", "吧", "着", "过", "地", "得", "所以", "因为",
]);

/** ICU word segmentation for CJK; falls back to whole runs where unavailable. */
const cjkSegmenter: Intl.Segmenter | null = (() => {
	try {
		return new Intl.Segmenter("zh-Hans", { granularity: "word" });
	} catch {
		return null;
	}
})();

/**
 * Segment a CJK run into words. Chinese has no spaces, so a run like
 * 多头注意力机制 must be split before it can be matched against page text —
 * matching the whole run only succeeds on a verbatim repetition of the query.
 */
export function segmentCjk(run: string): string[] {
	if (!cjkSegmenter) return [run];
	const raw = [...cjkSegmenter.segment(run)].filter((s) => s.isWordLike).map((s) => s.segment);
	const out: string[] = [];
	let carry = "";
	for (const s of raw) {
		if (s.length === 1 && !CJK_STOPWORDS.has(s)) {
			carry += s;
			continue;
		}
		if (carry) {
			out.push(carry + s);
			carry = "";
			continue;
		}
		out.push(s);
	}
	if (carry) out.push(carry);
	return out.filter((t) => t.length >= 2 && !CJK_STOPWORDS.has(t));
}

/** Latin tokens (len >= 2, non-stopword) plus dictionary-segmented CJK words. */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const run of text.match(CJK_RUN_G) ?? []) out.push(...segmentCjk(run));
	const words = text
		.toLowerCase()
		.replace(CJK_CHAR_G, " ")
		.match(/[a-z0-9][a-z0-9'._-]*/g) ?? [];
	for (const w of words) {
		if (w.length >= 2 && !STOPWORDS.has(w)) out.push(w);
	}
	return out;
}

/**
 * Length of a text in comparable "words". CJK text has no spaces, so
 * `split(/\s+/).length` reports a Chinese page as a handful of words and every
 * word-count threshold (thin-page detection, "content usable directly") then
 * misfires. Chinese averages ~1.6 characters per word.
 */
export function countWords(text: string): number {
	if (!text || !text.trim()) return 0;
	const cjk = (text.match(CJK_CHAR_G) ?? []).length;
	const latin = text.replace(CJK_CHAR_G, " ").trim().split(/\s+/).filter(Boolean).length;
	return latin + Math.ceil(cjk / 1.6);
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

/** Boundary-aware term match: Latin `lts` must not match `results`; CJK stays substring-based. */
export function containsSearchTerm(text: string, term: string): boolean {
	if (!term) return false;
	if (CJK_CHAR.test(term)) return text.includes(term);
	const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const start = /^[a-z0-9]/i.test(term) ? "(?:^|[^a-z0-9])" : "";
	const end = /[a-z0-9]$/i.test(term) ? "(?=$|[^a-z0-9])" : "";
	return new RegExp(`${start}${escaped}${end}`, "i").test(text.toLowerCase());
}

/** Boundary-aware global matcher for relevance scoring. */
export function searchTermRegExp(term: string): RegExp {
	const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (CJK_CHAR.test(term)) return new RegExp(escaped, "g");
	const start = /^[a-z0-9]/i.test(term) ? "(?:^|[^a-z0-9])" : "";
	const end = /[a-z0-9]$/i.test(term) ? "(?=$|[^a-z0-9])" : "";
	return new RegExp(`${start}${escaped}${end}`, "g");
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

/** True for loopback, RFC1918, link-local, CGNAT, and unique-local addresses. */
export function isPrivateOrLocalIp(ip: string): boolean {
	const kind = isIP(ip);
	if (kind === 4) {
		const [a, b] = ip.split(".").map(Number);
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true;
		if (a === 198 && (b === 18 || b === 19)) return true;
		return false;
	}
	if (kind === 6) {
		const lower = ip.toLowerCase();
		if (lower === "::1" || lower === "::") return true;
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
		if (mapped) return isPrivateOrLocalIp(mapped[1]);
		const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
		if (mappedHex) {
			const hi = parseInt(mappedHex[1], 16);
			const lo = parseInt(mappedHex[2], 16);
			return isPrivateOrLocalIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
		}
		const first = parseInt(lower.split(":")[0] || "0", 16);
		if ((first & 0xfe00) === 0xfc00) return true; // unique local
		if ((first & 0xffc0) === 0xfe80) return true; // link-local
		return false;
	}
	return false;
}

/**
 * Clash/mihomo/sing-box TUN mode answers EVERY DNS query with a synthetic IP
 * from 198.18.0.0/15 (RFC 2544 benchmarking range — used only by TUN proxies).
 * Blocking that range makes every real page lookup fail on TUN machines with
 * "resolves to private IP 198.18.0.x" while the connection would actually be
 * routed by the TUN device to the real host.
 *
 * The guard must treat an all-fake-ip DNS answer as "public via TUN" — while
 * literal private IPs, loopback, metadata, RFC1918 etc. stay blocked.
 */
export function isTunFakeIp(ip: string): boolean {
	if (isIP(ip) !== 4) return false;
	const [a, b] = ip.split(".").map(Number);
	return a === 198 && (b === 18 || b === 19);
}

/** Explicit opt-in: fake-IP DNS is private-range routing and must not be allowed by default. */
const ALLOW_TUN_FAKE_IP = process.env.PI_SEARCH_ALLOW_TUN_FAKEIP === "1";

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home"];

interface DnsAddress {
	address: string;
	family: number;
}

async function lookupWithAbort(host: string, signal?: AbortSignal): Promise<DnsAddress[]> {
	throwIfAborted(signal);
	const pending = lookupPromise(host, { all: true }) as Promise<DnsAddress[]>;
	if (!signal) return pending;
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([pending, aborted]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

/** Resolve and reject any private answer. Returned addresses are safe to pin to a socket. */
async function resolvePublicAddresses(host: string, signal?: AbortSignal): Promise<DnsAddress[]> {
	const results = await lookupWithAbort(host, signal);
	if (results.length === 0) throw new Error("blocked url: cannot resolve host");
	const viaTun = ALLOW_TUN_FAKE_IP && results.every((result) => isTunFakeIp(result.address));
	if (!viaTun) {
		for (const result of results) {
			if (isPrivateOrLocalIp(result.address)) {
				throw new Error(`blocked url: resolves to private IP ${result.address}`);
			}
		}
	}
	return results;
}

/**
 * Reject URLs that would let fetch_page hit loopback, private networks, or
 * cloud metadata. `fetchText(publicRedirects)` additionally pins an address
 * returned by this guard into the actual socket lookup to defeat rebinding.
 */
export async function assertPublicHttpUrl(raw: string, signal?: AbortSignal): Promise<void> {
	const { host } = parsePublicHttpUrl(raw);
	if (isIP(host)) return;
	try {
		await resolvePublicAddresses(host, signal);
	} catch (err) {
		throwIfAborted(signal);
		if (err instanceof Error && err.message.startsWith("blocked url:")) throw err;
		throw new Error("blocked url: cannot resolve host");
	}
}

function parsePublicHttpUrl(raw: string): { url: URL; host: string } {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("blocked url: invalid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("blocked url: only http(s) allowed");
	}
	if (url.username || url.password) throw new Error("blocked url: userinfo not allowed");
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (!host) throw new Error("blocked url: empty host");
	if (
		host === "localhost" ||
		host === "metadata.google.internal" ||
		BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
	) throw new Error("blocked url: private/local host");
	if (/^\d+$/.test(host)) throw new Error("blocked url: numeric host");
	if (isIP(host) && isPrivateOrLocalIp(host)) throw new Error("blocked url: private IP");
	return { url, host };
}
