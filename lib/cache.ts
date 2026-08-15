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
	/** set by clear(): the next flush drops the on-disk contents instead of merging */
	private cleared = false;
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
		this.cleared = true;
		this.scheduleSave();
	}

	private scheduleSave(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.flush(), 250);
		this.saveTimer.unref?.();
	}

	/**
	 * Persist to disk, merging whatever another process wrote since this one
	 * loaded the file. `research_parallel` runs several pi processes against the
	 * same cache file, and a plain whole-file rewrite made the last writer erase
	 * every entry the others had added.
	 */
	flush(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			const now = Date.now();
			const merged = new Map<string, CacheEntry>();
			if (!this.cleared) {
				try {
					const onDisk = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, CacheEntry>;
					for (const [k, v] of Object.entries(onDisk)) {
						if (v && typeof v.expiresAt === "number" && v.expiresAt > now) merged.set(k, v);
					}
				} catch {
					// missing or corrupt file: this process's view becomes the new file
				}
			}
			this.cleared = false;
			for (const [k, v] of this.data) {
				if (v.expiresAt > now) merged.set(k, v);
			}
			const tmp = `${this.file}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(merged)));
			fs.renameSync(tmp, this.file);
			this.saves++;
		} catch {
			// best-effort persistence
		}
	}
}
