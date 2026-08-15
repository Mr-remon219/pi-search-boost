/**
 * TTL JSON cache (step 6): search results + fetched pages, persisted to disk.
 * Dedupe helpers (URL normalization) live in util.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface CacheEntry {
	expiresAt: number;
	data: unknown;
}

export class JsonCache {
	private data = new Map<string, CacheEntry>();
	private hits = 0;
	private saves = 0;
	private saveTimer: NodeJS.Timeout | null = null;
	private readonly file: string;

	constructor(filePath: string) {
		this.file = filePath;
		try {
			if (fs.existsSync(filePath)) {
				const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, CacheEntry>;
				const now = Date.now();
				for (const [k, v] of Object.entries(raw)) {
					if (v && typeof v.expiresAt === "number" && v.expiresAt > now) {
						this.data.set(k, v);
					}
				}
			}
		} catch {
			// corrupt cache file — start fresh
		}
	}

	get<T>(key: string): T | undefined {
		const entry = this.data.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt < Date.now()) {
			this.data.delete(key);
			return undefined;
		}
		this.hits++;
		return entry.data as T;
	}

	set(key: string, value: unknown, ttlSeconds: number): void {
		this.data.set(key, { expiresAt: Date.now() + ttlSeconds * 1000, data: value });
		this.scheduleSave();
	}

	stats(): { entries: number; hits: number; saves: number; file: string } {
		return { entries: this.data.size, hits: this.hits, saves: this.saves, file: this.file };
	}

	clear(): void {
		this.data.clear();
		this.scheduleSave();
	}

	private scheduleSave(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.flush(), 250);
		this.saveTimer.unref?.();
	}

	flush(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.data)));
			this.saves++;
		} catch {
			// best-effort persistence
		}
	}
}
