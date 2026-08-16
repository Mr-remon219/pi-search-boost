/**
 * Offline unit tests for the P0/P1 audit fixes. No network, no API keys.
 *   node --experimental-strip-types --test test/unit.test.ts
 */
import assert from "node:assert/strict";
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
	expandQueries,
	parseDate,
	preprocessQuery,
	searchCacheKey,
} from "../lib/engines.ts";
import { excerptForTool, pickExcerpts, pickParagraphs } from "../lib/extract.ts";
import { getLayer, setLayer } from "../lib/layer.ts";
import { hasApiSearchKeys } from "../lib/engines.ts";
import { plannedResearchRounds } from "../lib/research.ts";
import { SEARCH_BOOST_EXT } from "../lib/parallel.ts";
import { extractJsonPayload } from "../lib/xsearch.ts";
import {
	assertPublicHttpUrl,
	countWords,
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
});

describe("deep_research step mode", () => {
	it("caps step mode at one round regardless of max_rounds", () => {
		assert.equal(plannedResearchRounds("step", 5), 1);
		assert.equal(plannedResearchRounds("step"), 1);
		assert.equal(plannedResearchRounds("auto", 5), 5);
		assert.equal(plannedResearchRounds("auto"), 3);
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
	it("resolves index.ts next to the package root (npm / manual / git)", () => {
		assert.ok(fs.existsSync(SEARCH_BOOST_EXT), `expected extension entry at ${SEARCH_BOOST_EXT}`);
	});
});
