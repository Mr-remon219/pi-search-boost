/**
 * Web-layer selection for search-boost.
 *
 * Two layers, switched at runtime with `/web_change` (verbatim extension
 * command name):
 *   - "free": keyless Exa MCP (web_search_exa on mcp.exa.ai) — single engine
 *   - "api" : Tavily + Brave + Exa + TinyFish API keys — the multi-engine fused route
 *
 * The choice persists to disk so it survives reloads. With no saved preference,
 * defaults to `api` when search API keys are configured, otherwise `free`
 * (keyless Exa MCP) so first-time users can search without setup.
 *
 * No pi-package imports here (AGENTS.md contract: lib/ imports only each other
 * + node built-ins). The state file mirrors pi's getAgentDir() resolution:
 * PI_CODING_AGENT_DIR env var, falling back to ~/.pi/agent.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hasApiSearchKeys } from "./engines.ts";

export type WebLayer = "free" | "api";

export const LAYER_LABELS: Record<WebLayer, string> = {
	free: "free — exa-free keyless (single engine, no fusion cross-check)",
	api: "api — tavily + brave + exa + tinyfish API (multi-engine fusion)",
};

/** Same resolution as pi's getAgentDir(): env override, else ~/.pi/agent. */
function agentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir.replace(/^~(?=$|[\\/])/, os.homedir());
	return path.join(os.homedir(), ".pi", "agent");
}

const STATE_FILE = path.join(agentDir(), "search-boost-layer.json");

let cached: WebLayer | undefined;
let cachedMtimeMs = -1;

/** Serialize writes so a busy session cannot corrupt/race the state file. */
let writeQueue: Promise<void> = Promise.resolve();

export function getLayer(): WebLayer {
	// Local setLayer() may have updated cached before the async disk write finishes.
	if (cached && cachedMtimeMs === -1) return cached;
	try {
		const mtimeMs = fs.statSync(STATE_FILE).mtimeMs;
		if (cached && cachedMtimeMs === mtimeMs) return cached;
		const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { layer?: unknown };
		if (raw?.layer === "free" || raw?.layer === "api") {
			cached = raw.layer;
			cachedMtimeMs = mtimeMs;
			return cached;
		}
	} catch {
		/* no state file yet — pick a sensible default */
	}
	return cached ?? (hasApiSearchKeys() ? "api" : "free");
}

export function setLayer(layer: WebLayer): WebLayer {
	cached = layer;
	cachedMtimeMs = -1;
	writeQueue = writeQueue.then(() => {
		try {
			const dir = path.dirname(STATE_FILE);
			fs.mkdirSync(dir, { recursive: true });
			const tmp = `${STATE_FILE}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify({ layer }, null, 2), "utf8");
			fs.renameSync(tmp, STATE_FILE);
			try {
				cachedMtimeMs = fs.statSync(STATE_FILE).mtimeMs;
			} catch {
				cachedMtimeMs = -1;
			}
		} catch (err) {
			// never break a search over state persistence
			console.error("search-boost: failed to persist layer state:", err);
		}
	});
	return layer;
}