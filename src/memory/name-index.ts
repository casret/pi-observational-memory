import {
	existsSync,
	lstatSync,
	mkdirSync,
	readlinkSync,
	readdirSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Global, human-browsable index of per-project observational-memory roots. */
export function memoryNameIndexDir(): string {
	return join(getAgentDir(), "om-memory");
}

/**
 * Turn a mutable display name into one safe filename component. The immutable session id is
 * always appended separately, so lossy normalization cannot merge two sessions.
 */
export function safeSessionName(name: string | undefined): string {
	const normalized = (name ?? "")
		.normalize("NFKC")
		.trim()
		.replace(/[\\/\0]/g, "-")
		.replace(/[\x00-\x1f\x7f]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/[^\p{L}\p{N}._-]+/gu, "-")
		.replace(/-+/g, "-")
		.replace(/^[._-]+|[._-]+$/g, "")
		.slice(0, 80)
		.replace(/[._-]+$/g, "");
	return normalized || "unnamed";
}

function safeSessionId(sessionId: string): string {
	return sessionId.replace(/[^A-Za-z0-9-]/g, "-") || "unknown";
}

export function memoryNameLinkName(sessionName: string | undefined, sessionId: string): string {
	return `${safeSessionName(sessionName)}--${safeSessionId(sessionId).slice(0, 8)}`;
}

function symlinkTarget(indexDir: string, path: string): string | undefined {
	try {
		if (!lstatSync(path).isSymbolicLink()) return undefined;
		return resolve(indexDir, readlinkSync(path));
	} catch {
		return undefined;
	}
}

function pathAvailableFor(indexDir: string, path: string, memoryRoot: string): boolean {
	return !existsSync(path) && symlinkTarget(indexDir, path) === undefined
		? true
		: symlinkTarget(indexDir, path) === resolve(memoryRoot);
}

/**
 * Add or refresh this session's global friendly-name symlink. Renames remove older links to the
 * same canonical memory root. Existing unrelated paths are never overwritten.
 *
 * Returns the symlink path, or undefined when the memory root is absent or indexing fails.
 */
export function syncMemoryNameIndex(
	memoryRoot: string,
	sessionId: string,
	sessionName: string | undefined,
	indexDir = memoryNameIndexDir(),
): string | undefined {
	if (!existsSync(memoryRoot)) return undefined;
	try {
		mkdirSync(indexDir, { recursive: true });
		const resolvedRoot = resolve(memoryRoot);
		const preferred = join(indexDir, memoryNameLinkName(sessionName, sessionId));
		const fullIdFallback = join(indexDir, `${safeSessionName(sessionName)}--${safeSessionId(sessionId)}`);
		const destination = pathAvailableFor(indexDir, preferred, resolvedRoot)
			? preferred
			: pathAvailableFor(indexDir, fullIdFallback, resolvedRoot)
				? fullIdFallback
				: undefined;
		if (!destination) return undefined;

		// Create directly with EEXIST semantics so a racing unrelated file is never replaced.
		if (symlinkTarget(indexDir, destination) !== resolvedRoot) {
			symlinkSync(resolvedRoot, destination, "dir");
		}

		for (const entry of readdirSync(indexDir)) {
			const path = join(indexDir, entry);
			if (path !== destination && symlinkTarget(indexDir, path) === resolvedRoot) {
				unlinkSync(path);
			}
		}
		return destination;
	} catch {
		// The memory pipeline must remain usable on read-only homes or platforms that disallow
		// symlink creation. The canonical per-project memory is still authoritative.
		return undefined;
	}
}
