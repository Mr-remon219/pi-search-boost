/**
 * x_search — direct HTTP implementation of Grok Build's X tools.
 *
 * Unlike the previous grok-CLI-subprocess approach, pi itself is the caller:
 * it reads the local grok installation's credentials (~/.grok/auth.json OIDC
 * session, refreshed via OIDC when expired) or an XAI_API_KEY, then POSTs the
 * Responses-API request to the sampling endpoint with the hosted
 * `{"type":"x_search"}` tool. The server executes the X search; the model's
 * final message carries the results (structured JSON when the prompt asks).
 *
 * Endpoints (identical wire format — same code path):
 *   - API key : https://api.x.ai/v1/responses      (public, docs.x.ai/developers/tools/x-search)
 *   - grok OIDC: https://cli-chat-proxy.grok.com/v1/responses (grok CLI's internal endpoint,
 *     requires the x-grok-client-version gate, e.g. "1.0.4")
 *
 * Requirements: grok CLI installed + logged in (SuperGrok / X Premium+ tier),
 * or XAI_API_KEY env var. Server-side rejections surface as errors.
 */
import * as os from "node:os";
import {
	readPiAuth,
	readGrokAuth,
	savePiAuth,
	syncGrokAuthKey,
	oidcRefresh,
	jwtTier,
	type AuthEntry,
} from "./xauth.ts";

export type XSearchType = "keyword" | "semantic" | "user" | "thread";

export interface XSearchParams {
	type: XSearchType;
	query?: string;
	username?: string;
	post_id?: string;
	/** hosted-tool level: max 20 handles */
	allowed_x_handles?: string[];
	excluded_x_handles?: string[];
	from_date?: string;
	to_date?: string;
	model?: string;
	/** reasoning effort for the driving model ("low" is fast and sufficient) */
	reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
	timeout_ms?: number;
	signal?: AbortSignal;
}

export interface XSearchResult {
	type: XSearchType;
	/** final model message text (parsed JSON when possible) */
	data: unknown;
	raw: string;
	model: string;
	baseUrl: string;
	credential: "api-key" | "grok-session";
	tookMs: number;
}

interface Credentials {
	kind: "api-key" | "grok-session";
	baseUrl: string;
	token: string;
	headers: Record<string, string>;
}

const INTERNAL_BASE = "https://cli-chat-proxy.grok.com/v1";
const PUBLIC_BASE = "https://api.x.ai/v1";
/** server gate: refuses requests below this CLI version (x-grok-client-version) */
const CLIENT_VERSION = "1.0.4";

/**
 * Resolve credentials for the official hosted x_search path.
 * Only XAI_API_KEY env or the pi-local copy (written by /x-login) count;
 * ~/.grok/auth.json is not auto-consumed — the official path must be
 * explicitly enabled with /x-login (or /x-login -k).
 */
async function resolveCredentials(signal?: AbortSignal): Promise<Credentials> {
	const apiKey = process.env.XAI_API_KEY;
	if (apiKey && apiKey.startsWith("xai-")) {
		return {
			kind: "api-key",
			baseUrl: PUBLIC_BASE,
			token: apiKey,
			headers: { authorization: `Bearer ${apiKey}` },
		};
	}
	const entry = readPiAuth();
	if (!entry?.key) {
		throw new Error(
			"official x_search is not enabled: run /x-login (imports your grok login) or /x-login -k <XAI_API_KEY>. Until then x_search uses the multi-engine / guest-GraphQL / oEmbed fallback chain only.",
		);
	}
	let token = entry.key;
	const exp = jwtTier(token)?.exp;
	if (exp && exp * 1000 < Date.now() + 60_000) {
		token = await oidcRefresh(entry);
		entry.key = token;
		// persist: pi-local copy is authoritative; keep grok in sync if we can
		savePiAuth({ ...entry, kind: "grok-session" });
		syncGrokAuthKey(token);
	}
	return {
		kind: entry.kind === "api-key" ? "api-key" : "grok-session",
		baseUrl: entry.kind === "api-key" ? PUBLIC_BASE : INTERNAL_BASE,
		token,
		headers:
			entry.kind === "api-key"
				? { authorization: `Bearer ${token}` }
				: {
						authorization: `Bearer ${token}`,
						"user-agent": `grok-shell/${CLIENT_VERSION} (${os.platform()}; ${os.arch() === "arm64" ? "aarch64" : os.arch()})`,
						"x-grok-client-version": CLIENT_VERSION,
						"x-grok-client-identifier": "grok-shell",
				  },
	};
}

/** Build the prompt that drives the model toward one X sub-tool + structured output. */
export function buildPrompt(params: XSearchParams): string {
	const isUser = params.type === "user";
	const schema = isUser
		? '{"id":str,"name":str,"username":str,"bio":str,"followers":num,"following":num,"verified":bool}'
		: '{"id":str,"author":str,"username":str,"text":str,"timestamp":str,"likes":num,"reposts":num,"replies":num,"views":num,"media":[str]}';
	const dateNote = [params.from_date && `from_date=${params.from_date}`, params.to_date && `to_date=${params.to_date}`]
		.filter(Boolean)
		.join(", ");
	let task: string;
	switch (params.type) {
		case "keyword":
			task = `Search X posts with the keyword query: ${JSON.stringify(params.query ?? params.username ?? "")}`;
			break;
		case "semantic":
			task = `Search X posts semantically related to: ${JSON.stringify(params.query ?? "")}`;
			break;
		case "user":
			task = `Search X USER ACCOUNTS (not posts) matching: ${JSON.stringify(params.username ?? params.query ?? "")}`;
			break;
		case "thread":
			task = `Fetch the full X conversation (root post, parent, replies) for post id: ${params.post_id ?? ""}`;
			break;
	}
	return [
		"You have the x_search tool. Use it now for this task:",
		task,
		dateNote ? `Restrict the search range to: ${dateNote}.` : "",
		params.allowed_x_handles?.length ? `Only consider posts from these handles: ${params.allowed_x_handles.join(", ")}.` : "",
		params.excluded_x_handles?.length ? `Exclude posts from these handles: ${params.excluded_x_handles.join(", ")}.` : "",
		"",
		"After the tool returns, your ENTIRE reply must be ONLY a valid JSON array (no prose, no fences), each element shaped like:",
		schema,
		`Return up to ${isUser ? "10" : "20"} items. If the tool found nothing, reply [] .`,
	].filter(Boolean).join("\n");
}

function buildToolConfig(params: XSearchParams): Record<string, unknown> {
	if (params.allowed_x_handles?.length && params.excluded_x_handles?.length) {
		throw new Error("allowed_x_handles and excluded_x_handles are mutually exclusive");
	}
	const cfg: Record<string, unknown> = { type: "x_search" };
	if (params.allowed_x_handles?.length) cfg.allowed_x_handles = params.allowed_x_handles.slice(0, 20);
	if (params.excluded_x_handles?.length) cfg.excluded_x_handles = params.excluded_x_handles.slice(0, 20);
	if (params.from_date) cfg.from_date = params.from_date;
	if (params.to_date) cfg.to_date = params.to_date;
	return cfg;
}

/** Strip optional markdown fences the model may wrap around JSON output. */
export function extractJsonPayload(raw: string): string {
	const trimmed = raw.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)```\s*$/i.exec(trimmed);
	if (fenced) return fenced[1]!.trim();
	const inline = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (inline) return inline[1]!.trim();
	return trimmed;
}

function parseFinalMessage(response: unknown): { raw: string; data: unknown } {
	const output = (response as { output?: unknown[] })?.output ?? [];
	let text = "";
	for (const o of output) {
		if (o && (o as { type?: string }).type === "message") {
			const content = (o as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
			for (const c of content) {
				if (c?.type === "output_text" && c.text) text += c.text;
			}
		}
	}
	const raw = text.trim();
	const payload = extractJsonPayload(raw);
	try {
		return { raw, data: JSON.parse(payload) };
	} catch {
		return { raw, data: raw };
	}
}

/**
 * Fast synchronous credential probe (no network): is the official hosted
 * x_search path usable right now? Only XAI_API_KEY env or the pi-local copy
 * (written by /x-login) count — ~/.grok/auth.json is NOT auto-consumed;
 * the official path must be explicitly enabled with /x-login.
 * Returns false when nothing is available, so the caller can route straight
 * to the multi-engine fallback chain instead of waiting on a timeout.
 */
export function xAuthAvailableSync(): boolean {
	if (process.env.XAI_API_KEY?.startsWith("xai-")) return true;
	return !!readPiAuth()?.key;
}

/**
 * Run one X search — pi itself POSTs the Responses-API request with the
 * hosted x_search tool. No grok subprocess is spawned.
 */
export async function runXTool(params: XSearchParams): Promise<XSearchResult> {
	const creds = await resolveCredentials(params.signal);
	const started = Date.now();
	const timeoutMs = params.timeout_ms ?? 90_000;

	const body: Record<string, unknown> = {
		model: params.model ?? "grok-4.6",
		reasoning: { effort: params.reasoning_effort ?? "low" },
		input: [{ role: "user", content: [{ type: "input_text", text: buildPrompt(params) }] }],
		tools: [buildToolConfig(params)],
		stream: false,
	};

	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
	const res = await fetch(`${creds.baseUrl}/responses`, {
		method: "POST",
		headers: { "content-type": "application/json", ...creds.headers },
		body: JSON.stringify(body),
		signal,
	});
	const tookMs = Date.now() - started;
	if (!res.ok) {
		const detail = (await res.text()).slice(0, 500);
		throw new Error(`x_search HTTP ${res.status} (${tookMs}ms): ${detail}`);
	}
	const response = (await res.json()) as unknown;
	const { raw, data } = parseFinalMessage(response);

	// server-side entitlement rejection surfaces as prose in the final message
	const lower = raw.toLowerCase();
	if (
		!Array.isArray(data) &&
		(lower.includes("subscription required") ||
			lower.includes("not entitled") ||
			lower.includes("x tools are not available") ||
			lower.includes("no access to x"))
	) {
		throw new Error(`x_search rejected: ${raw.slice(0, 400)}`);
	}

	return {
		type: params.type,
		data,
		raw,
		model: params.model ?? "grok-4.6",
		baseUrl: creds.baseUrl,
		credential: creds.kind,
		tookMs,
	};
}
