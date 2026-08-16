/**
 * Audit log (JSONL, append-only) — records every search / fetch / research
 * event so we can analyze real usage and find optimization opportunities.
 * File: <agentDir>/search-boost-audit.jsonl, rotated at 5MB (keeps one .old).
 */
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;

export interface AuditSearchEvent {
	type: "search";
	ts: string;
	query: string;
	queriesUsed: string[];
	engines: string[];
	engineErrors: Record<string, string>;
	results: number;
	cacheHits: number;
	/** complexity tier used (simple/medium/complex) */
	tier?: string;
	/** search layer used (free | api) */
	layer?: string;
	tookMs: number;
	topUrls: string[];
}

export interface AuditFetchEvent {
	type: "fetch";
	ts: string;
	url: string;
	domain: string;
	via: "jina" | "local" | "cache" | "jina-browser" | "failed";
	ok: boolean;
	error?: string;
	status?: number;
	wordCount?: number;
	bytes?: number;
	cacheHit: boolean;
	tookMs: number;
	jinaError?: string;
	localError?: string;
}

export interface AuditResearchEvent {
	type: "research";
	ts: string;
	query: string;
	mode: string;
	rounds: number;
	stopReason: string;
	sources: number;
	domains: number;
	uncovered: string[];
	tookMs: number;
}

export type AuditEvent = AuditSearchEvent | AuditFetchEvent | AuditResearchEvent;

export class AuditLog {
	private readonly file: string;
	private bytes = 0;

	constructor(filePath: string) {
		this.file = filePath;
		try {
			if (fs.existsSync(filePath)) this.bytes = fs.statSync(filePath).size;
		} catch {
			/* ignore */
		}
	}

	write(evt: AuditEvent): void {
		try {
			const line = JSON.stringify(evt) + "\n";
			if (this.bytes + line.length > MAX_BYTES) {
				// rotate: keep one .old
				try {
					fs.renameSync(this.file, `${this.file}.old`);
				} catch {
					/* ignore */
				}
				this.bytes = 0;
			}
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			// async write: never block the tool's hot path
			void fs.promises.appendFile(this.file, line, "utf8").catch(() => {});
			this.bytes += line.length;
		} catch {
			/* audit must never break search */
		}
	}

	/** Read the last N events (current + .old, chronological). */
	readTail(n: number): AuditEvent[] {
		const out: AuditEvent[] = [];
		const old = `${this.file}.old`;
		const files = [old, this.file];
		for (const f of files) {
			try {
				if (!fs.existsSync(f)) continue;
				const size = fs.statSync(f).size;
				const fd = fs.openSync(f, "r");
				const CHUNK = 64 * 1024;
				let pos = Math.max(0, size - CHUNK);
				let buffer = "";
				try {
					// read from the tail backwards; when the file is smaller than one
					// chunk, read the whole file in a single pass (pos === 0 must
					// still read, not skip the loop)
					while (true) {
						const b = Buffer.alloc(Math.min(CHUNK, size - pos));
						fs.readSync(fd, b, 0, b.length, pos);
						buffer = b.toString("utf8") + buffer;
						if (pos === 0 || buffer.length > n * 400) break;
						pos = Math.max(0, pos - CHUNK);
					}
				} finally {
					fs.closeSync(fd);
				}
				for (const line of buffer.split("\n")) {
					if (!line.trim()) continue;
					try {
						out.push(JSON.parse(line) as AuditEvent);
					} catch {
						/* skip corrupt line */
					}
				}
			} catch {
				/* ignore */
			}
		}
		return out.slice(-n);
	}

	/** Read all events (current + .old, chronological). */
	readAll(): AuditEvent[] {
		const out: AuditEvent[] = [];
		const old = `${this.file}.old`;
		const files = [old, this.file];
		for (const f of files) {
			try {
				if (!fs.existsSync(f)) continue;
				for (const line of fs.readFileSync(f, "utf8").split("\n")) {
					if (!line.trim()) continue;
					try {
						out.push(JSON.parse(line) as AuditEvent);
					} catch {
						/* skip corrupt line */
					}
				}
			} catch {
				/* ignore */
			}
		}
		return out;
	}

	clear(): void {
		try {
			fs.rmSync(this.file, { force: true });
			fs.rmSync(`${this.file}.old`, { force: true });
			this.bytes = 0;
		} catch {
			/* ignore */
		}
	}
}
