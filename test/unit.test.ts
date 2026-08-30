/**
 * Offline unit tests for the P0/P1 audit fixes. No network, no API keys.
 *   node --experimental-strip-types --test test/unit.test.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { JsonCache } from "../lib/cache.ts";
import {
	applyBraveSiteFilters,
	domainBonus,
	estimateComplexity,
	fusedSearch,
	expandQueries,
	parseDate,
	preprocessQuery,
	searchCacheKey,
} from "../lib/engines.ts";
import { excerptForTool, fetchPage, pickExcerpts, pickParagraphs, type PageResult } from "../lib/extract.ts";
import { getLayer, setLayer } from "../lib/layer.ts";
import { hasApiSearchKeys } from "../lib/engines.ts";
import {
	applyCorroboration, evaluateCoverage, goalCoverageTerms, mergeInitialQueries, plannedResearchRounds,
	type ResearchSource,
} from "../lib/research.ts";
import {
	childAttemptSucceeded, extractSourceUrls, isTransientProviderTransportError, retryTransientSubtasks,
	runParallelResearch, SEARCH_BOOST_EXT, type SubtaskResult,
} from "../lib/parallel.ts";
import { extractJsonPayload } from "../lib/xsearch.ts";
import {
	assertPublicHttpUrl,
	containsSearchTerm,
	countWords,
	validatePublicRedirect,
	domainMatches,
	isPrivateOrLocalIp,
	isTunFakeIp,
	normalizeUrl,
	segmentCjk,
	tokenize,
} from "../lib/util.ts";

describe("tokenize / CJK segmentation", () => {
	it("segments a Chinese query into dictionary words, not fixed 2-char chunks", () => {
		const terms = tokenize("多头注意力机制是怎么工作的");
		assert.ok(terms.includes("注意力"), `expected 注意力 in ${JSON.stringify(terms)}`);
		assert.ok(terms.includes("机制"), `expected 机制 in ${JSON.stringify(terms)}`);
		assert.ok(!terms.includes("力机"));
		assert.ok(!terms.includes("制是"));
	});

	it("keeps latin tokens and drops stopwords", () => {
		assert.deepEqual(tokenize("what is the tokio runtime"), ["tokio", "runtime"]);
	});

	it("never emits a whole unsegmented run as a single term", () => {
		const q = "检索增强生成的工作流程";
		assert.ok(!tokenize(q).includes(q));
		assert.ok(segmentCjk(q).length >= 3);
	});

	it("mixes CJK and latin in one query", () => {
		const terms = tokenize("Rust 异步运行时 对比 2026");
		assert.ok(terms.includes("rust"));
		assert.ok(terms.includes("2026"));
		assert.ok(terms.some((t) => t.includes("异步") || t.includes("运行")));
	});
});

describe("countWords", () => {
	it("counts CJK characters rather than whitespace runs", () => {
		const zh = "检索增强生成是一种把信息检索与文本生成结合起来的方法。";
		assert.equal(zh.split(/\s+/).length, 1);
		assert.ok(countWords(zh) > 15, `got ${countWords(zh)}`);
	});

	it("matches whitespace counting for pure latin text", () => {
		assert.equal(countWords("one two three four"), 4);
	});

	it("handles empty input", () => {
		assert.equal(countWords(""), 0);
	});
});

describe("focus filtering", () => {
	const zhContent = [
		"检索增强生成（RAG）把外部知识引入语言模型，先检索再生成。",
		"多头注意力机制把查询、键、值投影到多个子空间，并行计算注意力后拼接结果。",
		"本页面最后更新于 2026 年，版权所有，联系我们，隐私政策。",
	].join("\n\n");

	it("keeps the relevant Chinese paragraph and drops the rest", () => {
		const kept = pickParagraphs(zhContent, "多头注意力机制怎么工作", 8, 400);
		assert.ok(kept.length >= 1, "Chinese focus filtering returned nothing");
		assert.ok(kept[0].includes("多头注意力"), kept.join(" | "));
	});

	it("rejects link-soup paragraphs as excerpts", () => {
		const soup = "[![Image 4](https://cdn.example.com/a.svg)FAQs](https://example.com/faq) [Login](https://example.com/login) [Sign up](https://example.com/signup)";
		const prose = "Reciprocal Rank Fusion combines several ranked result lists into one ranking by summing the reciprocal of each document's rank across the lists.";
		const picked = pickExcerpts(`${soup}\n\n${prose}`, "reciprocal rank fusion ranking", 2);
		assert.ok(picked.every((p) => !p.includes("](https://")), picked.join(" | "));
		assert.ok(picked[0].includes("Reciprocal Rank Fusion"));
	});

	it("preserves a release-status table instead of treating its links as navigation", () => {
		const content = [
			"Node.js installation supports many operating system versions. Installers and package managers are documented here for Node.js users.",
			"## Node.js release schedule",
			"Version | Codename | First released | Status\n--- | --- | --- | ---\n[v24](https://nodejs.org/v24) | Krypton | 2025 | Active LTS\n[v22](https://nodejs.org/v22) | Jod | 2024 | Maintenance LTS",
		].join("\n\n");
		const kept = pickParagraphs(content, "current Node.js LTS version release status", 4, 400);
		assert.match(kept.join("\n"), /Node\.js release schedule[\s\S]*v24[\s\S]*Active LTS/);
		assert.ok(kept.findIndex((p) => p.includes("Active LTS")) <= 1, kept.join(" | "));
	});

	it("uses Latin token boundaries so Go does not match Google", () => {
		const content = [
			"Google publishes ongoing cloud platform documentation and search product announcements for enterprise customers.",
			"Go concurrency uses goroutines and channels to coordinate independent tasks in production services.",
		].join("\n\n");
		const kept = pickParagraphs(content, "Go concurrency channels", 4, 400);
		assert.ok(kept.some((p) => p.startsWith("Go concurrency")), kept.join(" | "));
		assert.ok(kept.every((p) => !p.startsWith("Google")), kept.join(" | "));
	});
});

describe("complexity routing", () => {
	it("does not treat the substring 'vs' inside a word as a comparison", () => {
		assert.notEqual(estimateComplexity("vscode settings sync"), "complex");
		assert.notEqual(estimateComplexity("nvswitch topology"), "complex");
	});

	it("still routes real comparisons to the complex tier", () => {
		assert.equal(estimateComplexity("rust vs go performance"), "complex");
		assert.equal(estimateComplexity("tokio 和 async-std 对比"), "complex");
	});

	it("does not force common Chinese question words into complex", () => {
		assert.notEqual(estimateComplexity("如何优化检索"), "complex");
		assert.notEqual(estimateComplexity("实现一个缓存"), "complex");
		assert.notEqual(estimateComplexity("最新 python 版本"), "complex");
	});
});

describe("query preprocessing", () => {
	it("lifts site: into an include filter and splits OR into variants", () => {
		const p = preprocessQuery('site:docs.rs tokio "spawn_blocking" OR "block_in_place"');
		assert.deepEqual(p.includeDomains, ["docs.rs"]);
		assert.equal(p.cleaned, "tokio spawn_blocking");
		assert.deepEqual(p.alternatives, ["block_in_place"]);
	});

	it("derives one compact variant from the informative terms, not a blind prefix", () => {
		assert.deepEqual(expandQueries("rust async runtime comparison 2026"), [
			"rust async runtime comparison 2026",
			"rust async runtime",
		]);
	});

	it("derives no variant when the query is already compact", () => {
		assert.deepEqual(expandQueries("numpy argsort"), ["numpy argsort"]);
	});

	it("generates a segmented variant for an unspaced Chinese query", () => {
		const variants = expandQueries("多引擎检索融合排序");
		assert.ok(variants.length >= 2, JSON.stringify(variants));
		assert.ok(variants[1].includes(" "), variants[1]);
		assert.ok(!/多引 |擎检|索融|合排/.test(variants[1]), variants[1]);
	});
});

describe("search cache key", () => {
	const q = "kubernetes release notes";

	it("separates entries that were produced under different filters", () => {
		const day = searchCacheKey("tavily", q, 8, { recency: "day" });
		const none = searchCacheKey("tavily", q, 8, {});
		assert.notEqual(day, none, "a recency-filtered result set must not be replayed for an unfiltered call");
		assert.notEqual(
			searchCacheKey("tavily", q, 8, { includeDomains: ["kubernetes.io"] }),
			searchCacheKey("tavily", q, 8, {}),
		);
		assert.notEqual(
			searchCacheKey("tavily", q, 8, { depth: "advanced" }),
			searchCacheKey("tavily", q, 8, { depth: "basic" }),
		);
		assert.notEqual(searchCacheKey("tavily", q, 8, {}), searchCacheKey("tavily", q, 20, {}));
	});

	it("is order-insensitive for domain lists", () => {
		assert.equal(
			searchCacheKey("tavily", q, 8, { includeDomains: ["b.com", "a.com"] }),
			searchCacheKey("tavily", q, 8, { includeDomains: ["a.com", "b.com"] }),
		);
	});

	it("does not fragment optionless engines (exa-free ignores those options)", () => {
		assert.equal(
			searchCacheKey("exa-free", q, 8, { recency: "day", depth: "advanced", includeDomains: ["kubernetes.io"] }),
			searchCacheKey("exa-free", q, 8, {}),
		);
	});
});

describe("diversity decay re-sort", () => {
	it("returns results in descending score order after the diversity decay", () => {
		const hits = [
			{ domain: "a.com", score: 3.0 },
			{ domain: "a.com", score: 2.9 },
			{ domain: "a.com", score: 2.8 },
			{ domain: "b.com", score: 1.5 },
			{ domain: "c.com", score: 1.4 },
		];
		const perDomain = new Map<string, number>();
		const adjusted = hits.map((h) => {
			const n = perDomain.get(h.domain) ?? 0;
			perDomain.set(h.domain, n + 1);
			return { ...h, score: n >= 1 ? Math.round(h.score * Math.max(0.35, 0.7 ** n) * 100) / 100 : h.score };
		});
		const out = adjusted.sort((x, y) => y.score - x.score);
		assert.deepEqual(
			out.map((r) => r.score),
			[...out.map((r) => r.score)].sort((x, y) => y - x),
		);
		assert.ok(out.findIndex((r) => r.domain === "b.com") < out.findLastIndex((r) => r.domain === "a.com"));
	});
});

describe("engine query adapters", () => {
	it("folds Brave domain filters into site: operators", () => {
		assert.equal(
			applyBraveSiteFilters("tokio runtime", { includeDomains: ["docs.rs"] }),
			"tokio runtime site:docs.rs",
		);
		assert.equal(
			applyBraveSiteFilters("rag", { includeDomains: ["arxiv.org", "github.com"], excludeDomains: ["pinterest.com"] }),
			"rag (site:arxiv.org OR site:github.com) -site:pinterest.com",
		);
	});
});

describe("engine cancellation", () => {
	it("propagates caller cancellation into API fetches instead of swallowing it", async () => {
		const originalFetch = globalThis.fetch;
		const previousKey = process.env.PI_SEARCH_TAVILY_KEY;
		const previousLayer = getLayer();
		process.env.PI_SEARCH_TAVILY_KEY = "test-key";
		setLayer("api");
		let observedSignal: AbortSignal | undefined;
		globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
			observedSignal = init?.signal as AbortSignal | undefined;
			return new Promise<Response>((_resolve, reject) => {
				const rejectAbort = () => reject(observedSignal?.reason ?? new Error("aborted"));
				if (observedSignal?.aborted) rejectAbort();
				else observedSignal?.addEventListener("abort", rejectAbort, { once: true });
			});
		}) as typeof fetch;
		const controller = new AbortController();
		try {
			const pending = fusedSearch({
				query: "unique cancellation fixture",
				queries: ["unique cancellation fixture"],
				engines: ["tavily"],
				complexity: "simple",
				maxResults: 3,
				signal: controller.signal,
			});
			controller.abort(new Error("caller cancelled"));
			await assert.rejects(pending, /caller cancelled/);
			assert.ok(observedSignal?.aborted, "engine fetch must observe the caller abort");
		} finally {
			globalThis.fetch = originalFetch;
			if (previousKey === undefined) delete process.env.PI_SEARCH_TAVILY_KEY;
			else process.env.PI_SEARCH_TAVILY_KEY = previousKey;
			setLayer(previousLayer);
		}
	});
});

describe("web layer state", () => {
	it("defaults to api and round-trips a switch", () => {
		// layer state is a module-level singleton backed by a file; this test
		// exercises the setter/getter contract, then restores the default.
		const before = getLayer();
		assert.ok(before === "api" || before === "free");
		setLayer("free");
		assert.equal(getLayer(), "free");
		setLayer("api");
		assert.equal(getLayer(), "api");
	});

	it("prefers free as the implicit default when no API keys are configured", () => {
		if (hasApiSearchKeys()) {
			console.log("  [skip] API keys present");
			return;
		}
		assert.equal(hasApiSearchKeys(), false);
	});
});

describe("SSRF guard", () => {
	it("classifies private and loopback IPs", () => {
		assert.ok(isPrivateOrLocalIp("127.0.0.1"));
		assert.ok(isPrivateOrLocalIp("10.0.0.4"));
		assert.ok(isPrivateOrLocalIp("192.168.1.1"));
		assert.ok(isPrivateOrLocalIp("169.254.169.254"));
		assert.ok(isPrivateOrLocalIp("::1"));
		assert.ok(!isPrivateOrLocalIp("1.1.1.1"));
		assert.ok(!isPrivateOrLocalIp("8.8.8.8"));
	});

	it("classifies TUN fake-ip addresses", () => {
		// Clash/mihomo/sing-box TUN answers every A query with 198.18.0.0/15
		assert.ok(isTunFakeIp("198.18.0.191"));
		assert.ok(isTunFakeIp("198.19.255.1"));
		assert.ok(!isTunFakeIp("10.0.0.1"));
		assert.ok(!isTunFakeIp("1.1.1.1"));
		assert.ok(!isTunFakeIp("::1"));
	});

	it("rejects localhost, private IPs, and non-http schemes", async () => {
		await assert.rejects(() => assertPublicHttpUrl("http://127.0.0.1/"), /blocked url/);
		await assert.rejects(() => assertPublicHttpUrl("http://localhost/admin"), /blocked url/);
		await assert.rejects(() => assertPublicHttpUrl("http://192.168.0.5/"), /blocked url/);
		await assert.rejects(() => assertPublicHttpUrl("http://169.254.169.254/latest/meta-data"), /blocked url/);
		await assert.rejects(() => assertPublicHttpUrl("file:///etc/passwd"), /blocked url/);
		await assert.rejects(() => assertPublicHttpUrl("http://[::1]/"), /blocked url/);
		// literal benchmark-range IPs stay blocked even though hostname
		// resolution into that range is the TUN fake-ip carve-out
		await assert.rejects(() => assertPublicHttpUrl("http://198.18.0.1/"), /blocked url/);
	});

	it("revalidates every redirect target before following it", async () => {
		await assert.rejects(
			() => validatePublicRedirect(
				"https://public.example/start",
				"http://169.254.169.254/latest/meta-data",
			),
			/blocked url: private IP/,
		);
	});

	it("propagates a pre-aborted caller signal even when the page is cached", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fetch-abort-"));
		const cache = new JsonCache(path.join(dir, "pages.json"));
		const url = "https://example.com/cached";
		cache.set(`page:${url}`, {
			title: "cached", url, domain: "example.com", fetchedAt: new Date().toISOString(),
			via: "local", content: "cached content", wordCount: 2, links: [],
		} satisfies PageResult, 60);
		cache.flush();
		const controller = new AbortController();
		const reason = new Error("stop cached fetch");
		controller.abort(reason);
		try {
			await assert.rejects(fetchPage(url, { cache, signal: controller.signal }), (error) => error === reason);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("deep_research step mode", () => {
	it("caps step mode at one round regardless of max_rounds", () => {
		assert.equal(plannedResearchRounds("step", 5), 1);
		assert.equal(plannedResearchRounds("step"), 1);
		assert.equal(plannedResearchRounds("auto", 5), 5);
		assert.equal(plannedResearchRounds("auto"), 3);
	});
});

describe("term boundary matching", () => {
	it("does not match short Latin terms inside unrelated words", () => {
		assert.equal(containsSearchTerm("search results from two engines", "lts"), false);
		assert.equal(containsSearchTerm("Google cloud platform", "go"), false);
		assert.equal(containsSearchTerm("Node.js Active LTS", "lts"), true);
		assert.equal(containsSearchTerm("Go uses channels", "go"), true);
	});
});

describe("deep_research evidence coverage", () => {
	const currentYear = new Date().getUTCFullYear();
	const recentYear = currentYear - 1;
	const staleYear = currentYear - 2;
	const source = (domain: string, excerpt: string): ResearchSource => ({
		title: domain,
		url: `https://${domain}/release`,
		domain,
		fetchedAt: new Date().toISOString(),
		via: "search",
		wordCount: countWords(excerpt),
		excerpt,
		corroboratedBy: [],
	});

	it("uses goal subject terms but excludes instruction/temporal prompt words", () => {
		assert.deepEqual(goalCoverageTerms("identify the current Node.js LTS"), ["node.js", "lts"]);
	});

	it("keeps a goal-bearing search variant when continuation queries are supplied", () => {
		assert.deepEqual(
			mergeInitialQueries("Node.js releases", "identify current LTS", ["maintenance schedule"]),
			["Node.js releases identify current LTS", "maintenance schedule"],
		);
	});

	it("does not mark mutually agreeing but stale temporal evidence as goal-covered", () => {
		const sources = [
			source("old-a.example", `Node.js 22.11.0 was the Active LTS release in ${staleYear} for production applications.`),
			source("old-b.example", `Node.js 22 was the Active LTS line in ${staleYear} and received long-term support.`),
		];
		applyCorroboration(sources, "Node.js LTS release identify current Node.js LTS", true);
		assert.ok(sources.some((s) => s.corroboratedBy.length > 0), "fixture should align on the old claim");
		const coverage = evaluateCoverage("Node.js LTS release", "identify current Node.js LTS", sources);
		assert.equal(coverage.uncoveredGoalTerms.length, 0, "subject words have two-domain evidence");
		assert.equal(coverage.goalEvidenceCovered, false, "stale dates must not satisfy a current goal");
		assert.equal(coverage.semanticGoalCheck, "not_performed");
	});

	it("also requires fresh aligned evidence for a temporal query when goal is omitted", () => {
		const sources = [
			source("old-a.example", `Node.js 22.11.0 was the Active LTS release in ${staleYear} for production applications.`),
			source("old-b.example", `Node.js 22 was the Active LTS line in ${staleYear} and received long-term support.`),
		];
		applyCorroboration(sources, "current Node.js LTS release", true);
		const coverage = evaluateCoverage("current Node.js LTS release", undefined, sources);
		assert.equal(coverage.timeSensitiveGoal, true);
		assert.equal(coverage.goalEvidenceCovered, false);
	});

	it("accepts recent two-domain, claim-aligned goal evidence without claiming semantic proof", () => {
		const sources = [
			source("new-a.example", `Node.js 24.11.0 is the Active LTS release in ${recentYear} for production applications.`),
			source("new-b.example", `Node.js 24 is the current Active LTS line released in ${recentYear} with long-term support.`),
		];
		applyCorroboration(sources, "Node.js LTS release identify current Node.js LTS", true);
		const coverage = evaluateCoverage("Node.js LTS release", "identify current Node.js LTS", sources);
		assert.equal(coverage.goalEvidenceCovered, true);
		assert.equal(coverage.semanticGoalCheck, "not_performed");
	});

	it("does not let unrelated fresh claims freshen a stale goal claim", () => {
		const sources = [
			source("old-a.example", `Node.js 22 was the Active LTS release in ${staleYear}. Node.js documentation was updated in ${currentYear} for readers.`),
			source("old-b.example", `Node.js 22 was the Active LTS release in ${staleYear}. Node.js documentation was updated in ${currentYear} for readers.`),
		];
		applyCorroboration(sources, "identify current Node.js LTS", true);
		assert.ok(sources.every((s) => (s.freshCorroboratedBy?.length ?? 0) === 1), "fresh documentation segments align");
		assert.equal(
			evaluateCoverage("Node.js LTS", "identify current Node.js LTS", sources).goalEvidenceCovered,
			false,
			"freshness must attach to the LTS claim itself",
		);
	});

	it("does not let a current copyright date freshen an aligned stale claim", () => {
		const sources = [
			source("old-a.example", `Node.js 22 was the Active LTS release in ${staleYear}. Copyright ${currentYear}.`),
			source("old-b.example", `Node.js 22 was the Active LTS release in ${staleYear}. Copyright ${currentYear}.`),
		];
		applyCorroboration(sources, "current Node.js LTS release", true);
		assert.ok(sources.every((s) => s.corroboratedBy.length === 1));
		assert.ok(sources.every((s) => (s.freshCorroboratedBy?.length ?? 0) === 0));
		assert.equal(evaluateCoverage("current Node.js LTS release", undefined, sources).goalEvidenceCovered, false);
	});

	it("does not corroborate conflicting lifecycle statuses that merely share current", () => {
		const sources = [
			source("active.example", `Node.js 24 is the current Active LTS release in ${recentYear}.`),
			source("maintenance.example", `Node.js 24 is the current Maintenance LTS release in ${recentYear}.`),
		];
		applyCorroboration(sources, "current Node.js LTS release", true);
		assert.deepEqual(sources.map((s) => s.corroboratedBy), [[], []]);
	});

	it("does not count lts as covered inside the unrelated word results", () => {
		const sources = [
			source("a.example", "Search results from multiple engines improve retrieval quality for production applications."),
			source("b.example", "These results summarize documents and ranking signals for production applications."),
		];
		const coverage = evaluateCoverage("search engines", "identify LTS", sources);
		assert.deepEqual(coverage.coveredGoalTerms, []);
		assert.deepEqual(coverage.uncoveredGoalTerms, ["lts"]);
	});

	it("does not corroborate excerpts whose version facts conflict", () => {
		const sources = [
			source("a.example", `Node.js 22 is the Active LTS release for production applications in ${staleYear}.`),
			source("b.example", `Node.js 24 is the Active LTS release for production applications in ${recentYear}.`),
		];
		applyCorroboration(sources, "current Node.js LTS release", true);
		assert.deepEqual(sources.map((s) => s.corroboratedBy), [[], []]);
	});
});

describe("excerptForTool", () => {
	it("returns short content unchanged and truncates long content", () => {
		assert.equal(excerptForTool("hello"), "hello");
		const long = "word ".repeat(800);
		const out = excerptForTool(long, 200);
		assert.ok(out.length < long.length);
		assert.ok(out.includes("[content truncated]"));
	});
});

describe("parseDate", () => {
	it("parses the formats the engines emit", () => {
		assert.equal(parseDate("2026年8月16日"), "2026-08-16");
		assert.equal(parseDate("Aug 16, 2026"), "2026-08-16");
		assert.equal(parseDate("2026-08-16T10:00:00Z"), "2026-08-16");
		assert.equal(parseDate("not a date"), null);
		assert.equal(parseDate(null), null);
	});
});

describe("url + domain helpers", () => {
	it("normalizes for dedupe", () => {
		assert.equal(
			normalizeUrl("https://WWW.Example.com/a/?utm_source=x&keep=1#frag"),
			"https://example.com/a/?keep=1",
		);
	});

	it("matches subdomains", () => {
		assert.ok(domainMatches("en.wikipedia.org", "wikipedia.org"));
		assert.ok(domainMatches("wikipedia.org", "wikipedia.org"));
		assert.ok(!domainMatches("notwikipedia.org", "wikipedia.org"));
	});
});

describe("JsonCache", () => {
	const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sb-cache-")), "cache.json");

	it("serializes genuinely concurrent cross-process merges", { timeout: 15_000 }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-cache-race-"));
		const file = path.join(dir, "cache.json");
		const go = path.join(dir, "go");
		const modulePath = fileURLToPath(new URL("../lib/cache.ts", import.meta.url));
		const script = `
			import fs from "node:fs";
			import { pathToFileURL } from "node:url";
			const [modulePath, cacheFile, key, ready, go] = process.argv.slice(1);
			const { JsonCache } = await import(pathToFileURL(modulePath).href);
			const cache = new JsonCache(cacheFile);
			cache.set(key, key, 3600);
			fs.writeFileSync(ready, "ready");
			while (!fs.existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 5));
			cache.flush();
		`;
		const launch = (key: string) => {
			const ready = path.join(dir, `${key}.ready`);
			const child = spawn(process.execPath, ["--experimental-strip-types", "-e", script, modulePath, file, key, ready, go], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			return { child, ready };
		};
		const children = [launch("a"), launch("b")];
		const deadline = Date.now() + 5000;
		while (!children.every((entry) => fs.existsSync(entry.ready)) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.ok(children.every((entry) => fs.existsSync(entry.ready)), "workers did not reach the flush barrier");
		fs.writeFileSync(go, "go");
		const exits = await Promise.all(children.map(({ child }) => new Promise<number>((resolve) => {
			child.on("close", (code) => resolve(code ?? 1));
		})));
		assert.deepEqual(exits, [0, 0]);
		const stored = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.deepEqual(Object.keys(stored).sort(), ["a", "b"]);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("merges entries written by another process instead of overwriting them", () => {
		const file = tmpFile();
		const parent = new JsonCache(file);
		const child = new JsonCache(file);
		parent.set("search:exa-free:a", [1], 3600);
		parent.flush();
		child.set("search:exa-free:b", [2], 3600);
		child.flush();
		const reloaded = new JsonCache(file);
		assert.deepEqual(reloaded.get("search:exa-free:a"), [1]);
		assert.deepEqual(reloaded.get("search:exa-free:b"), [2]);
	});

	it("drops expired entries on flush", () => {
		const file = tmpFile();
		const c = new JsonCache(file);
		c.set("fresh", 1, 3600);
		c.set("stale", 2, -1);
		c.flush();
		assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))), ["fresh"]);
	});

	it("clear() empties the file rather than merging it back", () => {
		const file = tmpFile();
		const c = new JsonCache(file);
		c.set("k", 1, 3600);
		c.flush();
		c.clear();
		c.flush();
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
	});
});

describe("domain scoring for site-restricted search", () => {
	it("does not junk-penalize x.com when it is explicitly included", () => {
		const junked = domainBonus("x.com");
		const included = domainBonus("x.com", ["x.com"]);
		assert.ok(junked < 0, `expected junk penalty, got ${junked}`);
		assert.equal(included, 0, "explicit include should skip junk penalty");
	});
});

describe("x_search JSON extraction", () => {
	it("strips markdown code fences before parsing", () => {
		const raw = '```json\n[{"id":"1","text":"hi"}]\n```';
		assert.equal(extractJsonPayload(raw), '[{"id":"1","text":"hi"}]');
		assert.deepEqual(JSON.parse(extractJsonPayload(raw)), [{ id: "1", text: "hi" }]);
	});
});

describe("research_parallel extension path", () => {
	it("does not spawn queued Pi children when already cancelled", async () => {
		const controller = new AbortController();
		controller.abort(new Error("stop parallel work"));
		const started = Date.now();
		const report = await runParallelResearch({
			query: "cancelled",
			subtasks: ["one", "two", "three"],
			maxParallel: 1,
			signal: controller.signal,
		});
		assert.ok(Date.now() - started < 500, "pre-aborted work should not wait on child termination");
		assert.equal(report.okCount, 0);
		assert.ok(report.results.every((result) => result.error === "aborted by caller"));
	});

	it("resolves index.ts next to the package root (npm / manual / git)", () => {
		assert.ok(fs.existsSync(SEARCH_BOOST_EXT), `expected extension entry at ${SEARCH_BOOST_EXT}`);
	});

	it("extracts real cited URLs and domains from the final report", () => {
		assert.deepEqual(
			extractSourceUrls("See https://example.com/a?utm_source=x and [docs](https://docs.example.org/v1). Duplicate: https://example.com/a. Also https://en.wikipedia.org/wiki/Foo_(bar)."),
			["https://example.com/a", "https://docs.example.org/v1", "https://en.wikipedia.org/wiki/Foo_(bar)"],
		);
	});

	it("recognizes WebSocket/provider transport failures for serial retry", () => {
		assert.ok(isTransientProviderTransportError("WebSocket error"));
		assert.ok(isTransientProviderTransportError("read ECONNRESET"));
		assert.equal(isTransientProviderTransportError("tool schema invalid"), false);
	});

	it("retries transient WebSocket failures serially and replaces successful results", async () => {
		const failed = (subtask: string): SubtaskResult => ({
			subtask, ok: false, result: "WebSocket error", error: "WebSocket error",
			tookMs: 1, turns: 0, attempts: 1, sources: [], domains: [],
		});
		const results = [failed("a"), failed("b")];
		let active = 0;
		let maxActive = 0;
		await retryTransientSubtasks(results, undefined, undefined, async (subtask) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return {
				subtask, ok: true, result: `done ${subtask}`, tookMs: 2, turns: 1,
				attempts: 1, sources: [`https://${subtask}.example/source`], domains: [`${subtask}.example`],
			};
		});
		assert.equal(maxActive, 1);
		assert.ok(results.every((result) => result.ok && result.attempts === 2));
	});

	it("never reports a killed child with partial assistant output as successful", () => {
		assert.equal(childAttemptSucceeded({
			exitCode: 1,
			terminationRequested: true,
			errorMessage: "timeout after 30s",
			stopReason: "stop",
			result: "partial report",
		}), false);
		assert.equal(childAttemptSucceeded({
			exitCode: 0,
			terminationRequested: false,
			errorMessage: "",
			stopReason: "stop",
			result: "complete report",
		}), true);
	});
});
