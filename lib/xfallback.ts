/**
 * xfallback — fallback for x_search, entirely on the multi-engine route.
 *
 * Every search goes through the fused multi-engine router (the user's
 * configured api layer — Tavily/Brave/Exa — or the free layer's exa-free),
 * restricted to x.com / twitter.com. No Bing/DDG HTML parsing.
 *
 * Routing:
 *   keyword/semantic → multi-engine search (site-restricted) → oEmbed
 *                      enhancement for the top 1-2 status URLs (full text
 *                      beats title snippets; parallel, best-effort)
 *   user              → guest GraphQL (structured profile + recent timeline
 *                      with engagement) → multi-engine profile links
 *   thread            → oEmbed single-post full text
 *
 * Zero-auth channels kept: guest GraphQL (X's anonymous web API, guest token
 * cached 2h on disk, query ids self-heal on rotation) and publish.x.com
 * oEmbed. Both are needed because the multi-engine route cannot do user
 * timelines or thread trees without an account.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as https from "node:https";
import * as dns from "node:dns";

export interface FallbackPost {
	id: string;
	author?: string;
	username?: string;
	text: string;
	url: string;
	likes?: number;
	reposts?: number;
	replies?: number;
	views?: number;
	media?: string[];
	timestamp?: string;
}

export interface FallbackUser {
	id: string;
	name: string;
	username: string;
	bio: string;
	followers?: number;
	following?: number;
	verified?: boolean;
	created_at?: string;
	recent_posts: FallbackPost[];
}

export interface FallbackResult {
	type: "keyword" | "semantic" | "user" | "thread";
	/** user → FallbackUser[]; others → FallbackPost[] */
	data: unknown;
	via: string;
}

/** A hit from the fused multi-engine router. */
export interface EngineHit {
	title?: string;
	url?: string;
	snippet?: string;
	domain?: string;
}const UA_CHROME =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

/** Public web bearer shipped by x.com's own JS — not a secret. */
const WEB_BEARER =
	"AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

/**
 * Windows + undici default to IPv6-first DNS, which times out against some
 * hosts. Force IPv4 lookups for the direct-to-X fetches.
 */
const ipv4Agent = new https.Agent({
	lookup: (hostname: string, options: dns.LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => {
		dns.lookup(hostname, { ...options, family: 4 }, callback);
	},
});

/** fetch with the IPv4 agent (agent is a runtime-only undici option, not in RequestInit types). */
function xfetch(url: string, init: RequestInit = {}): Promise<Response> {
	return fetch(url, { ...init, agent: ipv4Agent } as RequestInit & { agent?: https.Agent });
}

// ---------------------------------------------------------------------------
// guest token (mint + disk cache)
// ---------------------------------------------------------------------------

function agentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir.replace(/^~(?=$|[\\/])/, os.homedir());
	return path.join(os.homedir(), ".pi", "agent");
}

const GUEST_CACHE = path.join(agentDir(), "xsearch-guest.json");
const GUEST_TTL_MS = 2 * 60 * 60 * 1000;

function readGuestCache(): { token?: string; at?: number } | null {
	try {
		return JSON.parse(fs.readFileSync(GUEST_CACHE, "utf8")) as { token?: string; at?: number };
	} catch {
		return null;
	}
}

function writeGuestCache(token: string): void {
	try {
		fs.mkdirSync(path.dirname(GUEST_CACHE), { recursive: true });
		const tmp = `${GUEST_CACHE}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ token, at: Date.now() }), "utf8");
		fs.renameSync(tmp, GUEST_CACHE);
	} catch {
		/* cache is best-effort */
	}
}

async function guestToken(signal?: AbortSignal): Promise<string> {
	const cached = readGuestCache();
	if (cached?.token && cached.at && Date.now() - cached.at < GUEST_TTL_MS) {
		return cached.token;
	}
	const res = await xfetch("https://api.x.com/1.1/guest/activate.json", {
		method: "POST",
		headers: {
			authorization: `Bearer ${WEB_BEARER}`,
			origin: "https://x.com",
			referer: "https://x.com/",
			"user-agent": UA_CHROME,
		},
		signal: signal ?? AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`guest token mint failed (HTTP ${res.status})`);
	const d = (await res.json()) as { guest_token?: string };
	if (!d.guest_token) throw new Error("guest token mint returned no token");
	writeGuestCache(d.guest_token);
	return d.guest_token;
}

// ---------------------------------------------------------------------------
// guest GraphQL query ids (rotate on redeploy; 404 self-heals from x.com JS)
// ---------------------------------------------------------------------------

const DEFAULT_QUERY_IDS: Record<string, string> = {
	UserByScreenName: "Gb-d6r0vxPOADdG62OEBpQ",
	UserTweets: "SXVCYB8XHSS25nzIljNtZA",
};

const FEATURES = JSON.stringify({
	rweb_tipjar_consumption_enabled: true,
	responsive_web_graphql_exclude_directive_enabled: true,
	verified_phone_label_enabled: false,
	creator_subscriptions_tweet_preview_api_enabled: true,
	responsive_web_graphql_timeline_navigation_enabled: true,
	responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
	c9s_tweet_anatomy_moderator_badge_enabled: true,
	tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
	tweet_awards_web_tipping_enabled: false,
	responsive_web_media_download_video_enabled: false,
	profile_label_improvements_pcf_label_in_profile_enabled: false,
	longform_notetweets_consumption_enabled: true,
	responsive_web_enhance_cards_enabled: false,
	responsive_web_twitter_article_tweet_consumption_enabled: true,
	articles_preview_enabled: true,
	responsive_web_edit_tweet_api_enabled: true,
	rweb_video_timestamps_enabled: false,
	responsive_web_grok_share_attachment_enabled: true,
	immersive_video_status_linkable_timestamps: false,
	responsive_web_grok_analyze_post_followups_enabled: true,
	responsive_web_grok_analysis_button_from_backend: true,
	responsive_web_grok_community_note_auto_translation_is_enabled: false,
	responsive_web_grok_show_grok_translated_post: false,
	responsive_web_grok_annotations_enabled: false,
	post_ctas_fetch_enabled: false,
	responsive_web_grok_imagine_annotation_enabled: true,
	responsive_web_grok_image_annotation_enabled: true,
	responsive_web_twitter_blue_verified_badge_is_enabled: true,
	responsive_web_grok_show_analysis_button: true,
	responsive_web_grok_show_trends_button: false,
	view_counts_everywhere_api_enabled: true,
});

let healedQueryIds: Record<string, string> | null = null;

function queryIds(): Record<string, string> {
	return healedQueryIds ?? DEFAULT_QUERY_IDS;
}

async function healQueryIds(signal?: AbortSignal): Promise<boolean> {
	try {
		const page = await xfetch("https://x.com/search?q=test", {
			headers: { "user-agent": UA_CHROME },
			signal: signal ?? AbortSignal.timeout(30_000),
		});
		const html = await page.text();
		const jsUrls = [...html.matchAll(/https:\/\/abs\.twimg\.com\/[^"]+\.js/g)].map((m) => m[0]);
		const found: Record<string, string> = {};
		for (const jsUrl of jsUrls.slice(0, 4)) {
			const js = await (await xfetch(jsUrl, {
				headers: { "user-agent": UA_CHROME },
				signal: signal ?? AbortSignal.timeout(60_000),
			})).text();
			for (const m of js.matchAll(/queryId:"([A-Za-z0-9_-]{15,30})",operationName:"([A-Za-z0-9]+)"/g)) {
				if (m[2] in DEFAULT_QUERY_IDS && !(m[2] in found)) found[m[2]] = m[1];
			}
		}
		if (Object.keys(found).length === 0) return false;
		healedQueryIds = { ...DEFAULT_QUERY_IDS, ...found };
		return true;
	} catch {
		return false;
	}
}

function graphqlUrl(op: string, variables: Record<string, unknown>): string {
	const id = queryIds()[op] ?? DEFAULT_QUERY_IDS[op];
	return `https://x.com/i/api/graphql/${id}/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(FEATURES)}`;
}

async function graphqlGet(op: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
	const token = await guestToken(signal);
	const headers = {
		authorization: `Bearer ${WEB_BEARER}`,
		"x-guest-token": token,
		"x-twitter-client-language": "en",
		"x-twitter-active-user": "yes",
		referer: "https://x.com/",
		"user-agent": UA_CHROME,
	};
	const res = await xfetch(graphqlUrl(op, variables), { headers, signal: signal ?? AbortSignal.timeout(25_000) });
	if (res.status === 404) {
		// query id rotated — heal once and retry
		if (await healQueryIds(signal)) {
			const retry = await xfetch(graphqlUrl(op, variables), { headers, signal: signal ?? AbortSignal.timeout(25_000) });
			if (retry.ok) return retry.json();
		}
		throw new Error(`guest GraphQL ${op}: 404 (query id rotated, heal failed)`);
	}
	if (!res.ok) throw new Error(`guest GraphQL ${op}: HTTP ${res.status}`);
	return res.json();
}

function decodeUserId(base64Id: string): string {
	try {
		const raw = Buffer.from(base64Id, "base64").toString("utf8");
		const m = raw.match(/(\d+)$/);
		if (m) return m[1];
	} catch {
		/* fall through */
	}
	return base64Id;
}

function parseUser(d: unknown): FallbackUser | null {
	try {
		const u = (d as { data?: { user?: { result?: Record<string, unknown> } } }).data?.user?.result;
		if (!u) return null;
		const core = (u.core ?? {}) as Record<string, unknown>;
		const legacy = (u.legacy ?? {}) as Record<string, unknown>;
		const bio = (u.profile_bio as { description?: string } | undefined)?.description ?? String(legacy.description ?? "");
		const rel = (u.relationship_counts ?? {}) as Record<string, unknown>;
		const verif = (u.verification ?? {}) as Record<string, unknown>;
		const verifType = (u.verification_info ?? {}) as Record<string, unknown>;
		const id = String(u.rest_id ?? u.id ?? "");
		return {
			id: id.startsWith("VXNlcj") ? decodeUserId(id) : id,
			name: String(core.name ?? ""),
			username: String(core.screen_name ?? legacy.screen_name ?? ""),
			bio,
			followers: (rel.followers as number | undefined) ?? (legacy.followers_count as number | undefined),
			following: (rel.following as number | undefined) ?? (legacy.friends_count as number | undefined),
			verified: (u.is_blue_verified as boolean | undefined) ?? Boolean(verif.verified || verifType.is_identity_verified),
			created_at: String(core.created_at ?? ""),
			recent_posts: [],
		};
	} catch {
		return null;
	}
}

function parseTweets(d: unknown): FallbackPost[] {
	const out: FallbackPost[] = [];
	try {
		const insts = (d as { data?: { user?: { result?: { timeline?: { timeline?: { instructions?: unknown[] } } } } } })
			.data?.user?.result?.timeline?.timeline?.instructions ?? [];
		for (const inst of insts) {
			const ins = inst as { type?: string; entries?: unknown[] };
			if (ins.type !== "TimelineAddEntries" && ins.type !== "TimelinePinEntry") continue;
			for (const entry of (ins.entries ?? []) as Array<{ content?: { itemContent?: { tweet_results?: { result?: Record<string, unknown> } } } }>) {
				const t = entry.content?.itemContent?.tweet_results?.result;
				if (!t || t.__typename !== "Tweet") continue;
				const legacy = (t.legacy ?? {}) as Record<string, unknown>;
				const userRes = ((t.core ?? {}) as Record<string, unknown>).user_results as
					| { result?: Record<string, unknown> }
					| undefined;
				const userCore = userRes?.result?.core as Record<string, unknown> | undefined;
				const userLegacy = userRes?.result?.legacy as Record<string, unknown> | undefined;
				const media = (legacy.extended_entities as { media?: Array<{ media_url_https?: string; expanded_url?: string }> } | undefined)?.media;
				out.push({
					id: String(legacy.id_str ?? ""),
					author: String(userCore?.name ?? ""),
					username: String(userCore?.screen_name ?? userLegacy?.screen_name ?? ""),
					text: String(legacy.full_text ?? "").replace(/\n/g, " "),
					url: `https://x.com/${String(userCore?.screen_name ?? userLegacy?.screen_name ?? "x")}/status/${String(legacy.id_str ?? "")}`,
					likes: legacy.favorite_count as number | undefined,
					reposts: legacy.retweet_count as number | undefined,
					replies: legacy.reply_count as number | undefined,
					views: (t.views as { count?: number } | undefined)?.count,
					media: media?.map((m) => m.media_url_https ?? m.expanded_url ?? "").filter(Boolean),
					timestamp: String(legacy.created_at ?? ""),
				});
			}
		}
	} catch {
		/* keep what we have */
	}
	return out;
}

/** Structured user lookup: profile + recent posts, fully anonymous. */
export async function guestUser(username: string, postLimit = 5, signal?: AbortSignal): Promise<FallbackUser | null> {
	const clean = username.trim().replace(/^@+/, "");
	if (!clean) return null;
	const profile = await graphqlGet("UserByScreenName", { screen_name: clean, withSafetyModeUserFields: true }, signal);
	const user = parseUser(profile);
	if (!user) return null;
	try {
		const tl = await graphqlGet(
			"UserTweets",
			{
				userId: user.id,
				count: Math.min(postLimit + 5, 40),
				includePromotedContent: true,
				withQuickPromoteEligibilityTweetFields: true,
				withVoice: true,
				withVideos: true,
			},
			signal,
		);
		user.recent_posts = parseTweets(tl).slice(0, postLimit);
	} catch {
		/* timeline is a bonus — profile alone is still useful */
	}
	return user;
}

// ---------------------------------------------------------------------------
// oEmbed (single-post full text, anonymous)
// ---------------------------------------------------------------------------

/** Single post via X's anonymous oEmbed endpoint. */
export async function oembedPost(postId: string, signal?: AbortSignal): Promise<FallbackPost | null> {
	try {
		const url = `https://publish.x.com/oembed?url=${encodeURIComponent(`https://twitter.com/x/status/${postId}`)}&omit_script=true`;
		const res = await xfetch(url, { headers: { "user-agent": UA_CHROME }, signal: signal ?? AbortSignal.timeout(20_000) });
		if (!res.ok) return null;
		const d = (await res.json()) as { author_name?: string; author_url?: string; html?: string };
		const text = (d.html ?? "")
			.replace(/<blockquote[^>]*>/i, "")
			.replace(/<\/blockquote>/i, "")
			.replace(/<p[^>]*>/i, "")
			.replace(/<\/p>/i, "")
			.replace(/<a[^>]*>([^<]*)<\/a>/gi, " $1 ")
			.replace(/<[^>]+>/g, " ")
			.replace(/&mdash;/g, "—")
			.replace(/&amp;/g, "&")
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/\s+/g, " ")
			.trim();
		const username = (d.author_url ?? "").match(/x\.com\/([A-Za-z0-9_]+)/)?.[1];
		return { id: postId, author: d.author_name, username, text, url: `https://x.com/${username ?? "x"}/status/${postId}` };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// fallback router
// ---------------------------------------------------------------------------

/** "Author on X: text" title → {author, text}. */
export function splitXTitle(title: string): { author?: string; text: string } {
	const m = title.match(/^(.+?)\s+on\s+X:\s*(.+)$/);
	if (m) return { author: m[1], text: m[2].replace(/^"|"$/g, "") };
	return { text: title };
}

/** Engine hit → FallbackPost (title/snippet; oEmbed may upgrade it later). */
export function hitToPost(h: EngineHit): FallbackPost {
	const title = h.title ?? h.snippet ?? "";
	const { author, text } = splitXTitle(title);
	return {
		id: (h.url ?? "").match(/\/status\/(\d+)/)?.[1] ?? "",
		author: author ?? h.domain,
		text: text || title,
		url: h.url ?? "",
	};
}

/**
 * Multi-engine fallback for one x_search request.
 * `webSearch` is the injected fused_search route (api or free layer),
 * restricted to x.com/twitter.com by the caller.
 */
export async function fallbackXSearch(params: {
	type: "keyword" | "semantic" | "user" | "thread";
	query?: string;
	username?: string;
	post_id?: string;
	limit?: number;
	signal?: AbortSignal;
	/** injected: fused multi-engine search restricted to x.com */
	webSearch: (query: string, limit: number) => Promise<EngineHit[]>;
}): Promise<FallbackResult> {
	const limit = Math.min(params.limit ?? 3, 5);
	const signal = params.signal;

	// ---- thread: oEmbed single post (engines cannot reconstruct a thread) ----
	if (params.type === "thread") {
		const id = params.post_id?.match(/(?:status\/)?(\d{5,})/)?.[1];
		if (!id) throw new Error("fallback thread requires post_id");
		const post = await oembedPost(id, signal);
		return { type: "thread", data: post ? [post] : [], via: "oembed" };
	}

	// ---- user: guest GraphQL (structured) → multi-engine profile links ----
	if (params.type === "user") {
		const handle = params.username ?? params.query;
		if (!handle) throw new Error("fallback user requires username");
		try {
			const user = await guestUser(handle, limit, signal);
			if (user) return { type: "user", data: [user], via: "guest-graphql" };
		} catch {
			/* guest API failed → multi-engine */
		}
		const hits = await params.webSearch(`site:x.com ${handle}`, limit);
		const profiles = hits
			.filter((h) => h.url && !/\/status\//.test(h.url ?? ""))
			.map((h) => ({
				id: "",
				name: h.title ?? "",
				username: (h.url ?? "").split("/").pop(),
				bio: "",
				recent_posts: [],
				url: h.url ?? "",
			}));
		if (!profiles.length) throw new Error("fallback user: no profile results from engines");
		return { type: "user", data: profiles, via: "engines" };
	}

	// ---- keyword / semantic: multi-engine, oEmbed-upgrade top status URLs ----
	const query = params.query ?? (params.username ? `from:${params.username}` : "");
	if (!query) throw new Error(`fallback ${params.type} requires query`);
	const hits = await params.webSearch(query, limit);
	const posts = hits.filter((h) => h.title || h.snippet).map(hitToPost);
	if (!posts.length) throw new Error(`fallback ${params.type}: no results from engines`);

	// upgrade the first 1-2 posts that have a status id: oEmbed gives the full
	// text + author + id instead of a title snippet (parallel, best-effort)
	const upgradable = posts.filter((p) => p.id).slice(0, 2);
	if (upgradable.length) {
		const upgraded = await Promise.all(upgradable.map((p) => oembedPost(p.id, signal)));
		for (let i = 0; i < upgradable.length; i++) {
			const full = upgraded[i];
			if (full) posts[posts.indexOf(upgradable[i])] = full;
		}
	}
	return { type: params.type, data: posts, via: "engines" + (upgradable.length ? "+oembed" : "") };
}
