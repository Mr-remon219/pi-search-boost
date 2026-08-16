/**
 * Parallel multi-agent research (the "Grok Deep Research" pattern, kept lean):
 *
 * The main agent (orchestrator) decomposes a question into subtasks; each
 * subtask runs as an independent `pi` child process (own context window, own
 * search budget) with fused_search + fetch_page; results are collected in
 * parallel and handed back to the orchestrator for synthesis + cross-checking.
 *
 * Deliberately NOT a general-purpose multi-agent framework: no DAG, no
 * agent-to-agent messaging, no persistence, no retries. Fault isolation comes
 * free from process boundaries — a crashing subtask never harms the parent.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { pool } from "./util.ts";

export interface SubtaskResult {
	subtask: string;
	ok: boolean;
	result: string;
	tookMs: number;
	turns: number;
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

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

const SEARCH_BOOST_EXT = path.join(getAgentDir(), "extensions", "search-boost", "index.ts");

function buildSubtaskPrompt(subtask: string, maxSources: number): string {
	return [
		`You are a research subagent. Investigate ONE subtask of a larger research question.`,
		``,
		`<subtask>${subtask}</subtask>`,
		``,
		`Rules:`,
		`- Use fused_search with 2-4 keyword variants (different angles/phrasings; site: and OR are auto-translated). If searches fail with rate-limit (429), drop to 1 variant and continue with what you have.`,
		`- Fetch promising pages with fetch_page when snippets are insufficient.`,
		`- Return a concise report: findings with source URLs inline, at most ${maxSources} sources.`,
		`- Mark unverified or single-source claims explicitly.`,
		`- Do NOT use any other tools.`,
	].join("\n");
}

async function runSubtask(
	subtask: string,
	maxSources: number,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<SubtaskResult> {
	const started = Date.now();
	const prompt = buildSubtaskPrompt(subtask, maxSources);
	const args = [
		"-e", SEARCH_BOOST_EXT,
		"--mode", "json", "-p", "--no-session",
		"--tools", "fused_search,fetch_page",
		prompt,
	];
	const invocation = getPiInvocation(args);

	let turns = 0;
	let stopReason = "";
	let errorMessage = "";
	const messages: JsonlMessage[] = [];

	const exitCode = await new Promise<number>((resolve) => {
		const proc: ChildProcess = spawn(invocation.command, invocation.args, {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";
		const timer = setTimeout(() => {
			errorMessage = `timeout after ${Math.round(timeoutMs / 1000)}s`;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 3000);
		}, timeoutMs);
		timer.unref?.();

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: { type?: string; message?: JsonlMessage };
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "message_end" && event.message) {
				const msg = event.message;
				messages.push(msg);
				if (msg.role === "assistant") {
					turns++;
					if (msg.stopReason) stopReason = msg.stopReason;
					if (msg.errorMessage) errorMessage = msg.errorMessage;
				}
			}
			if (event.type === "tool_result_end" && event.message) {
				messages.push(event.message);
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.on("close", (code) => {
			clearTimeout(timer);
			if (buffer.trim()) processLine(buffer);
			resolve(code ?? 0);
		});
		proc.on("error", () => {
			clearTimeout(timer);
			resolve(1);
		});

		const killProc = () => {
			errorMessage = errorMessage || "aborted by caller";
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 3000);
		};
		if (signal?.aborted) killProc();
		else signal?.addEventListener("abort", killProc, { once: true });
	});

	// final text = last assistant text message
	let result = "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content ?? []) {
				if (part.type === "text" && part.text) {
					result = part.text;
					break;
				}
			}
			if (result) break;
		}
	}

	const ok = exitCode === 0 && stopReason !== "error" && stopReason !== "aborted" && result.length > 0;
	return {
		subtask,
		ok,
		result: result || errorMessage || "(no output)",
		tookMs: Date.now() - started,
		turns,
		error: ok ? undefined : errorMessage || `exit ${exitCode}, stop: ${stopReason || "?"}`,
	};
}

export async function runParallelResearch(opts: ParallelOptions): Promise<{
	query: string;
	results: SubtaskResult[];
	okCount: number;
	totalMs: number;
}> {
	const started = Date.now();
	const maxParallel = Math.min(4, Math.max(1, opts.maxParallel ?? 2));
	const maxSources = Math.min(8, Math.max(1, opts.perSubtaskSources ?? 3));
	const timeoutMs = Math.min(600, Math.max(30, opts.timeoutSeconds ?? 150)) * 1000;

	opts.progress?.(`research_parallel: ${opts.subtasks.length} subtasks, concurrency ${maxParallel}, ≤${maxSources} sources each`);
	const results = await pool(opts.subtasks, maxParallel, (subtask, i) => {
		opts.progress?.(`subtask ${i + 1}/${opts.subtasks.length}: "${subtask.slice(0, 60)}"`);
		return runSubtask(subtask, maxSources, timeoutMs, opts.signal);
	});

	return {
		query: opts.query,
		results,
		okCount: results.filter((r) => r.ok).length,
		totalMs: Date.now() - started,
	};
}
