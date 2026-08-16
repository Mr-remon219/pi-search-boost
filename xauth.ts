/**
 * xauth — credential management for x_search.
 *
 * The x_search tool needs xAI credentials. Sources, in priority order:
 *   1. XAI_API_KEY env var                 (public api.x.ai)
 *   2. <agentDir>/xsearch-auth.json        (pi-local copy, written by /x-login)
 *   3. ~/.grok/auth.json                   (grok CLI's own login, auto-imported on use)
 *
 * `/x-login` copies the grok session into pi's own directory so x_search no
 * longer needs to touch ~/.grok on every call. Token refresh (OIDC) writes
 * back to the pi-local file and best-effort syncs the grok file.
 *
 * No pi-package imports here (AGENTS.md contract): agentDir() mirrors pi's
 * getAgentDir() resolution (PI_CODING_AGENT_DIR env var, else ~/.pi/agent).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AuthEntry {
	kind: "api-key" | "grok-session";
	key?: string;
	refresh_token?: string;
	user_id?: string;
	principal_type?: string;
	principal_id?: string;
	oidc_issuer?: string;
	oidc_client_id?: string;
	email?: string;
	/** ISO timestamp of when this pi-local copy was imported/refreshed */
	synced_at?: string;
}

const GROK_AUTH_FILE = path.join(os.homedir(), ".grok", "auth.json");

/** Same resolution as pi's getAgentDir(): env override, else ~/.pi/agent. */
export function agentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir.replace(/^~(?=$|[\\/])/, os.homedir());
	return path.join(os.homedir(), ".pi", "agent");
}

export function piAuthPath(): string {
	return path.join(agentDir(), "xsearch-auth.json");
}

/** Read the pi-local credential copy. */
export function readPiAuth(): AuthEntry | null {
	try {
		const raw = JSON.parse(fs.readFileSync(piAuthPath(), "utf8")) as AuthEntry;
		if (raw && typeof raw === "object" && typeof raw.key === "string") return raw;
	} catch {
		/* not configured yet */
	}
	return null;
}

/** Read the grok CLI's own login (OIDC session). */
export function readGrokAuth(): AuthEntry | null {
	try {
		const raw = JSON.parse(fs.readFileSync(GROK_AUTH_FILE, "utf8")) as Record<string, unknown>;
		for (const v of Object.values(raw)) {
			if (v && typeof v === "object" && typeof (v as AuthEntry).key === "string") {
				return { ...(v as AuthEntry), kind: "grok-session" } as AuthEntry;
			}
		}
	} catch {
		/* no grok login */
	}
	return null;
}

/** Atomically persist the pi-local credential copy. */
export function savePiAuth(entry: AuthEntry): void {
	const dir = path.dirname(piAuthPath());
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${piAuthPath()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ ...entry, synced_at: new Date().toISOString() }, null, 2), "utf8");
	fs.renameSync(tmp, piAuthPath());
}

/** Remove the pi-local credential copy (disables the official hosted x_search
 * path — x_search then uses only the multi-engine / guest-GraphQL / oEmbed
 * fallback chain). Returns true if a credential file was removed. */
export function logout(): boolean {
	try {
		fs.unlinkSync(piAuthPath());
		return true;
	} catch {
		return false; // not present or already gone
	}
}

/** Best-effort sync a refreshed key back into grok's auth file (keeps grok CLI in sync). */
export function syncGrokAuthKey(newKey: string): void {
	try {
		const raw = JSON.parse(fs.readFileSync(GROK_AUTH_FILE, "utf8")) as Record<string, unknown>;
		for (const v of Object.values(raw)) {
			if (v && typeof v === "object" && typeof (v as AuthEntry).key === "string") {
				(v as AuthEntry).key = newKey;
			}
		}
		const tmp = `${GROK_AUTH_FILE}.pi-sync.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), "utf8");
		fs.renameSync(tmp, GROK_AUTH_FILE);
	} catch {
		/* read-only or missing — pi-local copy is authoritative for us */
	}
}

/** Import the grok login into pi's own directory. Returns the stored entry. */
export function importFromGrok(): AuthEntry {
	const grok = readGrokAuth();
	if (!grok?.key) {
		throw new Error(
			"no grok login found at ~/.grok/auth.json — run `grok login` first, or use `/x-login -k <XAI_API_KEY>`",
		);
	}
	const entry: AuthEntry = {
		kind: "grok-session",
		key: grok.key,
		refresh_token: grok.refresh_token,
		user_id: grok.user_id,
		principal_type: grok.principal_type,
		principal_id: grok.principal_id,
		oidc_issuer: grok.oidc_issuer,
		oidc_client_id: grok.oidc_client_id,
		email: grok.email,
	};
	savePiAuth(entry);
	return entry;
}

/** Store an API key in pi's own directory. */
export function importApiKey(key: string): AuthEntry {
	const clean = key.trim();
	if (!/^xai-[A-Za-z0-9_-]+$/.test(clean)) {
		throw new Error("invalid XAI API key (expected xai-...)");
	}
	const entry: AuthEntry = { kind: "api-key", key: clean };
	savePiAuth(entry);
	return entry;
}

/** Decode the tier claim from a JWT access token. */
export function jwtTier(token: string): { tier?: number; exp?: number } | null {
	try {
		const payload = token.split(".")[1];
		if (!payload) return null;
		const json = JSON.parse(
			Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
		) as { tier?: number; exp?: number };
		return json;
	} catch {
		return null;
	}
}

const TIER_NAMES: Record<number, string> = {
	0: "free",
	1: "supergrok",
	2: "x_basic",
	3: "x_premium",
	4: "x_premium_plus",
	5: "supergrok_heavy",
	6: "supergrok_lite",
	7: "supergrok_plus",
};

export function tierName(tier?: number): string {
	return tier === undefined ? "unknown" : TIER_NAMES[tier] ?? `tier_${tier}`;
}

/** Human-readable status of the current credential chain. */
export function authStatus(): {
	source: "api-key" | "pi-copy" | "grok" | "none";
	detail: string;
} {
	const envKey = process.env.XAI_API_KEY;
	if (envKey?.startsWith("xai-")) {
		return { source: "api-key", detail: `XAI_API_KEY env (${envKey.slice(0, 9)}…${envKey.slice(-4)})` };
	}
	const pi = readPiAuth();
	if (pi?.key) {
		if (pi.kind === "api-key") {
			return { source: "api-key", detail: `pi-local API key (${pi.key.slice(0, 9)}…${pi.key.slice(-4)})` };
		}
		const claims = jwtTier(pi.key);
		const exp = claims?.exp ? new Date(claims.exp * 1000).toISOString() : "unknown";
		return {
			source: "pi-copy",
			detail: `grok session (${pi.email ?? pi.user_id ?? "?"}), tier=${tierName(claims?.tier)}, expires ${exp}, synced ${pi.synced_at ?? "never"}`,
		};
	}
	const grok = readGrokAuth();
	if (grok?.key) {
		const claims = jwtTier(grok.key);
		const exp = claims?.exp ? new Date(claims.exp * 1000).toISOString() : "unknown";
		return {
			source: "grok",
			detail: `~/.grok/auth.json (${grok.email ?? grok.user_id ?? "?"}), tier=${tierName(claims?.tier)}, expires ${exp} — NOT imported; run /x-login to enable the official x_search path`,
		};
	}
	return { source: "none", detail: "no credentials — run /x-login or set XAI_API_KEY" };
}

/** OIDC refresh (discovery + form POST), returning the new access token. */
export async function oidcRefresh(entry: AuthEntry): Promise<string> {
	const issuer = entry.oidc_issuer ?? "https://auth.x.ai";
	const clientId = entry.oidc_client_id;
	const refreshToken = entry.refresh_token;
	if (!clientId || !refreshToken) throw new Error("credential has no refresh token — run /x-login again after `grok login`");
	const disc = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) });
	if (!disc.ok) throw new Error(`OIDC discovery failed (HTTP ${disc.status})`);
	const doc = (await disc.json()) as { token_endpoint?: string };
	const tokenEndpoint = doc.token_endpoint ?? `${issuer}/token`;
	const form = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: clientId,
	});
	if (entry.principal_type) form.set("principal_type", entry.principal_type);
	if (entry.principal_id) form.set("principal_id", entry.principal_id);
	const res = await fetch(tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: form,
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`grok token refresh failed (HTTP ${res.status})`);
	const body = (await res.json()) as { access_token?: string };
	if (!body.access_token) throw new Error("token refresh returned no access_token");
	return body.access_token;
}
