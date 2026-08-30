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

const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 3_000;
const sleepArray = new Int32Array(new SharedArrayBuffer(4));

interface FileLock {
	fd: number;
	token: string;
}

function processIsAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function lockOwner(raw: string): { pid?: number; token?: string } {
	try {
		return JSON.parse(raw) as { pid?: number; token?: string };
	} catch {
		return {};
	}
}

function acquireFileLock(lockPath: string): FileLock | null {
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (Date.now() < deadline) {
		try {
			const fd = fs.openSync(lockPath, "wx", 0o600);
			const token = JSON.stringify({
				pid: process.pid,
				token: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
			});
			fs.writeFileSync(fd, token);
			return { fd, token };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
			try {
				if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
					const observed = fs.readFileSync(lockPath, "utf8");
					const owner = lockOwner(observed);
					// A slow but live writer still owns the lock. Only recover locks
					// whose process is gone (or legacy/corrupt locks with no owner).
					if (owner.pid && processIsAlive(owner.pid)) {
						Atomics.wait(sleepArray, 0, 0, 20);
						continue;
					}
					// Re-read before unlink so a successor token is never removed
					// based on stale observations from an earlier owner.
					if (fs.readFileSync(lockPath, "utf8") === observed) fs.unlinkSync(lockPath);
					continue;
				}
			} catch {
				continue;
			}
			Atomics.wait(sleepArray, 0, 0, 20);
		}
	}
	return null;
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
		let lock: FileLock | null = null;
		const lockPath = `${this.file}.lock`;
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			lock = acquireFileLock(lockPath);
			if (lock === null) {
				this.scheduleSave();
				return;
			}
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
		} finally {
			if (lock !== null) {
				try { fs.closeSync(lock.fd); } catch { /* already closed */ }
				try {
					// Never unlink a lock acquired by a successor after recovery.
					if (fs.readFileSync(lockPath, "utf8") === lock.token) fs.unlinkSync(lockPath);
				} catch { /* best effort */ }
			}
		}
	}
}
