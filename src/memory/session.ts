/**
 * Per-session memory resolution, legacy migration, fork seeding, and transient-run cleanup.
 *
 * Memory lives beside the session transcript (see `sessionMemoryRoot` in paths.ts), never inside
 * the project tree: project-local `.memory/` leaked into version control, died with deleted jj
 * workspaces and /tmp, and scattered one session's state across whatever cwd it started in.
 *
 * The session id is the immutable session-header UUID (survives /name, /resume, /tree) read via
 * `sessionManager.getSessionId()`; the transcript path Pi assigns embeds it.
 *
 * On first touch a session's root is resolved in this order:
 *   1. already exists beside the transcript → use it (resume, /reload);
 *   2. legacy `<cwd>/.memory/<id>/` exists → MOVE it here (one-time migration, nothing left behind);
 *   3. the session has a parent (fork/clone/handoff) → seed a copy of the parent's memory;
 *   4. otherwise create it empty.
 * Transient `.runs/` IPC is never migrated or seeded.
 */
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	rmdirSync,
	statSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { runsDir } from "../spawn/runs.js";
import { legacySessionMemoryRoot, sessionFileMemoryRoot, sessionMemoryRoot } from "./paths.js";

type SessionCtx = {
	cwd: string;
	sessionManager: {
		getSessionId: () => string;
		getSessionFile?: () => string | undefined;
		getHeader?: () => { id?: string; cwd?: string; parentSession?: string } | null | undefined;
	};
};

/** Read a session file's header (first JSONL line). Undefined on any parse/IO failure. */
function readSessionHeader(file: string): { id?: string; cwd?: string } | undefined {
	try {
		const firstLine = readFileSync(file, "utf-8").split("\n", 1)[0] ?? "";
		const header = JSON.parse(firstLine) as { type?: string; id?: string; cwd?: string } | undefined;
		return header && typeof header === "object" ? header : undefined;
	} catch {
		return undefined;
	}
}

/** True for any path inside a `.runs` directory (transient IPC; never seeded or migrated). */
function isRunsPath(p: string): boolean {
	return basename(p) === ".runs" || p.includes(`${sep}.runs${sep}`);
}

/**
 * Candidate legacy roots for a session: its current cwd and the cwd recorded in its header
 * (they differ when a session is resumed from another directory). Deduplicated, existing only.
 */
function legacyRoots(sessionId: string, cwds: (string | undefined)[]): string[] {
	const seen = new Set<string>();
	const roots: string[] = [];
	for (const cwd of cwds) {
		if (!cwd) continue;
		const root = legacySessionMemoryRoot(cwd, sessionId);
		if (seen.has(root)) continue;
		seen.add(root);
		if (existsSync(root)) roots.push(root);
	}
	return roots;
}

/** Remove `<project>/.memory/` if migration left it empty. Never touches a non-empty dir. */
function removeEmptyLegacyBase(legacyRoot: string): void {
	const base = dirname(legacyRoot);
	try {
		if (basename(base) === ".memory" && readdirSync(base).length === 0) rmdirSync(base);
	} catch {
		/* best-effort */
	}
}

/**
 * Move a directory, falling back to copy+delete across filesystems. The destination appears
 * atomically (temp + rename) so a concurrent reader never sees a half-copied root. Transient
 * `.runs/` is dropped. Returns true on success; on failure the source is left intact.
 */
export function moveMemoryRoot(src: string, dest: string): boolean {
	mkdirSync(dirname(dest), { recursive: true });
	try {
		rmSync(runsDir(src), { recursive: true, force: true });
	} catch {
		/* transient; a leftover is swept later */
	}
	try {
		renameSync(src, dest);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") return false;
	}
	const tmp = `${dest}.migrate-tmp-${process.pid}-${Date.now()}`;
	try {
		cpSync(src, tmp, { recursive: true, filter: (p) => !isRunsPath(p) });
		renameSync(tmp, dest);
		rmSync(src, { recursive: true, force: true });
		return true;
	} catch {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
		return false;
	}
}

/**
 * Resolve the parent session's memory root for fork/clone/handoff seeding: beside the parent
 * transcript, else (not yet migrated) under the parent's legacy project location.
 */
function parentMemoryRoot(ctx: SessionCtx): string | undefined {
	const parentFile = ctx.sessionManager.getHeader?.()?.parentSession;
	if (!parentFile) return undefined;
	const beside = sessionFileMemoryRoot(parentFile);
	if (existsSync(beside)) return beside;
	const header = readSessionHeader(parentFile);
	if (!header?.id) return undefined;
	return legacyRoots(header.id, [header.cwd, ctx.cwd])[0];
}

/**
 * Resolve (creating/migrating/seeding as needed) this session's memory root. Idempotent: once
 * the root exists it is returned untouched. A session with OM enabled owns a real directory even
 * before its first worker write, keeping the global friendly-name symlink non-dangling.
 */
export function ensureSessionMemory(ctx: SessionCtx): string {
	const sessionId = ctx.sessionManager.getSessionId();
	const root = sessionMemoryRoot(ctx.sessionManager.getSessionFile?.(), sessionId);
	if (existsSync(root)) {
		sweepStaleRuns(root);
		return root;
	}

	const legacy = legacyRoots(sessionId, [ctx.cwd, ctx.sessionManager.getHeader?.()?.cwd])[0];
	if (legacy && moveMemoryRoot(legacy, root)) {
		removeEmptyLegacyBase(legacy);
		return root;
	}

	const parent = parentMemoryRoot(ctx);
	if (parent) {
		// Copy parent memory (minus transient .runs/) via temp+rename so a concurrent reader never
		// observes a half-seeded directory.
		mkdirSync(dirname(root), { recursive: true });
		const tmp = `${root}.seed-tmp-${process.pid}-${Date.now()}`;
		try {
			cpSync(parent, tmp, { recursive: true, filter: (src) => !isRunsPath(src) });
			renameSync(tmp, root);
		} catch {
			try {
				rmSync(tmp, { recursive: true, force: true });
			} catch {
				/* best-effort cleanup */
			}
		}
	}
	mkdirSync(root, { recursive: true });
	return root;
}

/** Transient worker files older than this are removed at session start. */
export const STALE_RUN_MS = 24 * 60 * 60 * 1000;

/**
 * Delete `.runs/` files older than `maxAgeMs`. Successful runs clean up after themselves (see
 * `removeRunFiles`); this catches failed/aborted runs, which are kept a day for debugging.
 */
export function sweepStaleRuns(root: string, maxAgeMs = STALE_RUN_MS, now = Date.now()): number {
	const dir = runsDir(root);
	let removed = 0;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const path = join(dir, entry);
		try {
			if (now - statSync(path).mtimeMs > maxAgeMs) {
				rmSync(path, { recursive: true, force: true });
				removed++;
			}
		} catch {
			/* raced with another sweeper or worker */
		}
	}
	return removed;
}

/** Remove one run's transient files (`<runId>.*`) after the orchestrator has consumed them. */
export function removeRunFiles(root: string, runId: string): void {
	const dir = runsDir(root);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry === runId || entry.startsWith(`${runId}.`)) {
			try {
				rmSync(join(dir, entry), { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	}
}
