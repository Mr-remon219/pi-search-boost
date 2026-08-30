/* Parallel research via isolated pi child processes. */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { hostOf, normalizeUrl, pool } from "./util.ts";

export interface SubtaskResult {
	subtask: string;
	ok: boolean;
	result: string;
	tookMs: number;
	turns: number;
	attempts: number;
	sources: string[];
	domains: string[];
	error?: string;
}

export interface ParallelOptions {
	query: string;
	subtasks: string[];
	maxParallel?: number;
	perSubtaskSources?: number;
	timeoutSeconds?: number;
	signal?: AbortSignal;
	progress?: (msg: string) => void;
}

interface JsonlMessage {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	stopReason?: string;
	errorMessage?: string;
}

function findPiCliScript(): string | null {
	const relative = path.join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
	const dirs = new Set<string>([path.dirname(process.execPath)]);
	for (const entry of (process.env.PATH ?? "").split(path.delimiter)) if (entry) dirs.add(entry);
	for (const dir of dirs) {
		const candidate = path.join(dir, relative);
		if (fs.existsSync(candidate)) return candidate;
		// npm-style launcher directory: derive the package root beside pi.cmd.
		if (fs.existsSync(path.join(dir, "pi.cmd"))) {
			const besideLauncher = path.join(dir, relative);
			if (fs.existsSync(besideLauncher)) return besideLauncher;
		}
	}
	return null;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	const isPiCliScript = !!currentScript && /pi-coding-agent[\\/].*[\\/]cli\.js$/i.test(currentScript);
	if (currentScript && isPiCliScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	// Windows cannot spawn .cmd launchers with shell:false. Execute Pi's real JS
	// entry with the current Node binary instead (also avoids shell injection).
	if (process.platform === "win32") {
		const cli = findPiCliScript();
		if (cli) return { command: process.execPath, args: [cli, ...args] };
	}
	return { command: "pi", args };
}

/** Resolve next to this package's index.ts (works for npm, git, and manual installs). */
export const SEARCH_BOOST_EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts");

function buildSubtaskPrompt(subtask: string, maxSources: number): string {
	return [
		"You are a research subagent. Investigate ONE subtask of a larger research question.",
		"",
		`<subtask>${subtask}</subtask>`,
		"",
		"Rules:",
		"- Use fused_search with 2-4 keyword variants (different angles/phrasings; site: and OR are auto-translated). If searches fail with rate-limit (429), drop to 1 variant and continue with what you have.",
		"- Fetch promising pages with fetch_page when snippets are insufficient.",
		`- Return a concise report: findings with source URLs inline, at most ${maxSources} sources.`,
		"- Mark unverified or single-source claims explicitly.",
		"- Do NOT use any other tools.",
	].join("\n");
}

function appendBounded(current: string, chunk: string, maxChars = 12_000): string {
	const combined = current + chunk;
	return combined.length <= maxChars ? combined : combined.slice(-maxChars);
}

/** Parse actual cited HTTP(S) URLs from a subagent's final report. */
export function extractSourceUrls(text: string): string[] {
	const urls = new Set<string>();
	for (const match of text.matchAll(/https?:\/\/[^\s<>"'`\]}]+/g)) {
		let cleaned = match[0]!
			.replace(/[.,;:!?]+$/, "")
			.replace(/(?:\*{1,3}|_{1,3}|~{1,2})$/, "");
		// Markdown link delimiters add an unmatched trailing ')'; balanced
		// parentheses inside real URLs (e.g. Wikipedia slugs) must survive.
		while (cleaned.endsWith(")") && (cleaned.match(/\)/g)?.length ?? 0) > (cleaned.match(/\(/g)?.length ?? 0)) {
			cleaned = cleaned.slice(0, -1);
		}
		const normalized = normalizeUrl(cleaned);
		if (normalized.startsWith("http") && hostOf(normalized)) urls.add(normalized);
	}
	return [...urls];
}

export function isTransientProviderTransportError(text: string): boolean {
	return /websocket|socket hang up|econnreset|econnrefused|etimedout|epipe|connection (?:closed|limit|reset)|network error|fetch failed/i.test(text);
}

export function childAttemptSucceeded(state: {
	exitCode: number;
	terminationRequested: boolean;
	errorMessage: string;
	stopReason: string;
	result: string;
}): boolean {
	return !state.terminationRequested && !state.errorMessage && state.exitCode === 0 &&
		state.stopReason !== "error" && state.stopReason !== "aborted" && state.result.length > 0;
}

function childEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	// Pi's shell-session metadata describes the parent, not this ephemeral child.
	// Removing it avoids nested processes exposing stale session paths/IDs.
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_SUBAGENT_PARENT_SESSION;
	return env;
}

function abortedSubtask(subtask: string, started = Date.now()): SubtaskResult {
	return {
		subtask,
		ok: false,
		result: "aborted by caller",
		error: "aborted by caller",
		tookMs: Date.now() - started,
		turns: 0,
		attempts: 1,
		sources: [],
		domains: [],
	};
}

async function runSubtaskAttempt(
	subtask: string,
	maxSources: number,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<SubtaskResult> {
	const started = Date.now();
	// The pool may invoke a queued worker after cancellation. Return without
	// constructing or spawning a Pi child in that case.
	if (signal?.aborted) return abortedSubtask(subtask, started);
	const prompt = buildSubtaskPrompt(subtask, maxSources);
	const args = [
		"-ne", // explicit -e below; prevent an installed copy from double-registering tools
		"-e", SEARCH_BOOST_EXT,
		"--mode", "json", "-p", "--no-session",
		"--tools", "fused_search,fetch_page",
		prompt,
	];
	const invocation = getPiInvocation(args);
	if (signal?.aborted) return abortedSubtask(subtask, started);
	let turns = 0;
	let stopReason = "";
	let errorMessage = "";
	let stderr = "";
	const messages: JsonlMessage[] = [];

	let terminationRequested = false;
	const exitCode = await new Promise<number>((resolve) => {
		let settled = false;
		let closed = false;
		let forceTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			resolve(code);
		};
		const proc: ChildProcess = spawn(invocation.command, invocation.args, {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: childEnvironment(),
		});
		let buffer = "";

		const forceStop = (reason: string) => {
			if (closed) return;
			terminationRequested = true;
			errorMessage ||= reason;
			try { proc.kill("SIGTERM"); } catch { /* already gone */ }
			forceTimer = setTimeout(() => {
				if (!closed) {
					try { proc.kill("SIGKILL"); } catch { /* already gone */ }
				}
			}, 3000);
			forceTimer.unref?.();
		};

		const timer = setTimeout(
			() => forceStop(`timeout after ${Math.round(timeoutMs / 1000)}s`),
			timeoutMs,
		);
		timer.unref?.();

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: { type?: string; message?: JsonlMessage };
			try { event = JSON.parse(line); } catch { return; }
			if (event.type !== "message_end" || !event.message) return;
			const msg = event.message;
			if (msg.role !== "assistant") return;
			messages.push(msg);
			turns++;
			if (msg.stopReason) stopReason = msg.stopReason;
			if (msg.errorMessage) errorMessage = msg.errorMessage;
		};

		proc.stdout?.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});
		proc.stderr?.on("data", (data) => {
			stderr = appendBounded(stderr, data.toString());
		});

		const onAbort = () => forceStop("aborted by caller");
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		proc.on("close", (code) => {
			closed = true;
			clearTimeout(timer);
			if (forceTimer) clearTimeout(forceTimer);
			signal?.removeEventListener("abort", onAbort);
			if (buffer.trim()) processLine(buffer);
			finish(code ?? 1);
		});
		proc.on("error", (error) => {
			errorMessage ||= error.message;
			clearTimeout(timer);
			if (forceTimer) clearTimeout(forceTimer);
			signal?.removeEventListener("abort", onAbort);
			finish(1);
		});
	});

	let result = "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]!;
		for (const part of msg.content ?? []) {
			if (part.type === "text" && part.text) {
				result = part.text;
				break;
			}
		}
		if (result) break;
	}
	const stderrDetail = stderr.trim().split(/\r?\n/).slice(-8).join(" | ");
	const error = errorMessage || stderrDetail || `exit ${exitCode}, stop: ${stopReason || "?"}`;
	const ok = childAttemptSucceeded({ exitCode, terminationRequested, errorMessage, stopReason, result });
	const sources = extractSourceUrls(result);
	return {
		subtask,
		ok,
		result: result || error || "(no output)",
		tookMs: Date.now() - started,
		turns,
		attempts: 1,
		sources,
		domains: [...new Set(sources.map(hostOf).filter(Boolean))],
		error: ok ? undefined : error,
	};
}

export async function retryTransientSubtasks(
	results: SubtaskResult[],
	signal: AbortSignal | undefined,
	progress: ((msg: string) => void) | undefined,
	attempt: (subtask: string) => Promise<SubtaskResult>,
): Promise<void> {
	// Concurrent provider WebSockets can hit transient connection limits. Retry
	// only transport failures, one-by-one, after the first parallel wave ends.
	for (let i = 0; i < results.length; i++) {
		const first = results[i]!;
		const diagnostic = `${first.error ?? ""}\n${first.result}`;
		if (first.ok || signal?.aborted || !isTransientProviderTransportError(diagnostic)) continue;
		progress?.(`subtask ${i + 1}: transient provider transport failure; retrying serially`);
		const retry = await attempt(first.subtask);
		retry.attempts = 2;
		retry.tookMs += first.tookMs;
		retry.turns += first.turns;
		if (!retry.ok) {
			retry.error = `${first.error ?? "first attempt failed"}; retry: ${retry.error ?? "failed"}`;
			if (/websocket/i.test(diagnostic + retry.error)) {
				retry.error += '; WebSocket failed twice — set Pi "transport" to "auto" or "sse" in ~/.pi/agent/settings.json';
			}
		}
		results[i] = retry;
	}
}

export async function runParallelResearch(opts: ParallelOptions): Promise<{
	query: string;
	results: SubtaskResult[];
	okCount: number;
	sourceUrls: string[];
	domains: string[];
	totalTurns: number;
	totalMs: number;
}> {
	const started = Date.now();
	const maxParallel = Math.min(4, Math.max(1, opts.maxParallel ?? 2));
	const maxSources = Math.min(8, Math.max(1, opts.perSubtaskSources ?? 3));
	const timeoutMs = Math.min(600, Math.max(30, opts.timeoutSeconds ?? 150)) * 1000;

	opts.progress?.(`research_parallel: ${opts.subtasks.length} subtasks, concurrency ${maxParallel}, ≤${maxSources} sources each`);
	const results = await pool(opts.subtasks, maxParallel, (subtask, index) => {
		opts.progress?.(`subtask ${index + 1}/${opts.subtasks.length}: "${subtask.slice(0, 60)}"`);
		return runSubtaskAttempt(subtask, maxSources, timeoutMs, opts.signal);
	});

	await retryTransientSubtasks(
		results,
		opts.signal,
		opts.progress,
		(subtask) => runSubtaskAttempt(subtask, maxSources, timeoutMs, opts.signal),
	);

	const sourceUrls = [...new Set(results.flatMap((result) => result.sources))];
	const domains = [...new Set(sourceUrls.map(hostOf).filter(Boolean))];
	return {
		query: opts.query,
		results,
		okCount: results.filter((result) => result.ok).length,
		sourceUrls,
		domains,
		totalTurns: results.reduce((sum, result) => sum + result.turns, 0),
		totalMs: Date.now() - started,
	};
}
