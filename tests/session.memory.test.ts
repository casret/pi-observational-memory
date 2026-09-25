import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	ephemeralMemoryRoot,
	legacySessionMemoryRoot,
	sessionFileMemoryRoot,
	sessionMemoryRoot,
} from "../src/memory/paths.js";
import { ensureSessionMemory, removeRunFiles, sweepStaleRuns } from "../src/memory/session.js";

let temp: string;
let cwd: string; // the project the session runs in
let sessionsDir: string; // stands in for ~/.pi/agent/sessions/<cwd-slug>/

beforeEach(() => {
	temp = mkdtempSync(join(tmpdir(), "om-session-"));
	cwd = join(temp, "project");
	sessionsDir = join(temp, "sessions", "--project--");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
	rmSync(temp, { recursive: true, force: true });
});

/** Session transcript path as Pi names it, with its header line written. */
function writeSessionFile(id: string, headerCwd = cwd): string {
	const file = join(sessionsDir, `2026-09-25T00-00-00-000Z_${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", id, cwd: headerCwd })}\n`, "utf-8");
	return file;
}

function fakeCtx(
	sessionId: string,
	opts: { sessionFile?: string | null; parentSession?: string; headerCwd?: string } = {},
) {
	const sessionFile = opts.sessionFile === null ? undefined : (opts.sessionFile ?? writeSessionFile(sessionId));
	return {
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
			getHeader: () => ({ id: sessionId, cwd: opts.headerCwd ?? cwd, parentSession: opts.parentSession }),
		},
	};
}

function writeLegacy(root: string): void {
	mkdirSync(join(root, ".runs"), { recursive: true });
	writeFileSync(join(root, "auth.md"), "---\nid: auth\n---\nlegacy body", "utf-8");
	writeFileSync(join(root, ".runs", "obs-1.prompt.md"), "transient", "utf-8");
}

describe("sessionMemoryRoot", () => {
	it("lives beside the transcript, never under the project", () => {
		const file = join(sessionsDir, "2026-09-25T00-00-00-000Z_abc.jsonl");
		expect(sessionMemoryRoot(file, "abc")).toBe(join(sessionsDir, "2026-09-25T00-00-00-000Z_abc.memory"));
		expect(sessionFileMemoryRoot(file)).toBe(sessionMemoryRoot(file, "abc"));
	});

	it("uses an explicitly ephemeral temp root when there is no transcript", () => {
		expect(sessionMemoryRoot(undefined, "abc")).toBe(ephemeralMemoryRoot("abc"));
		expect(ephemeralMemoryRoot("abc")).toContain("pi-om-ephemeral");
	});
});

describe("ensureSessionMemory", () => {
	it("creates the root beside the transcript even without a parent", () => {
		const ctx = fakeCtx("child");
		const root = ensureSessionMemory(ctx);
		expect(root).toBe(sessionFileMemoryRoot(ctx.sessionManager.getSessionFile()!));
		// A real directory keeps the central friendly-name symlink non-dangling before first write.
		expect(existsSync(root)).toBe(true);
		expect(existsSync(join(cwd, ".memory"))).toBe(false);
	});

	it("migrates legacy <cwd>/.memory/<id> by moving it, dropping .runs and the empty base", () => {
		const legacy = legacySessionMemoryRoot(cwd, "sess");
		writeLegacy(legacy);
		const root = ensureSessionMemory(fakeCtx("sess"));
		expect(readFileSync(join(root, "auth.md"), "utf-8")).toContain("legacy body");
		expect(existsSync(join(root, ".runs"))).toBe(false);
		expect(existsSync(legacy)).toBe(false);
		expect(existsSync(join(cwd, ".memory"))).toBe(false);
	});

	it("keeps the legacy base when other sessions still live there", () => {
		writeLegacy(legacySessionMemoryRoot(cwd, "sess"));
		writeLegacy(legacySessionMemoryRoot(cwd, "other"));
		ensureSessionMemory(fakeCtx("sess"));
		expect(existsSync(legacySessionMemoryRoot(cwd, "other"))).toBe(true);
	});

	it("migrates from the header cwd when the session is resumed elsewhere", () => {
		const origin = join(temp, "origin-project");
		const legacy = legacySessionMemoryRoot(origin, "sess");
		writeLegacy(legacy);
		const ctx = fakeCtx("sess", { sessionFile: writeSessionFile("sess", origin), headerCwd: origin });
		const root = ensureSessionMemory(ctx);
		expect(readFileSync(join(root, "auth.md"), "utf-8")).toContain("legacy body");
		expect(existsSync(legacy)).toBe(false);
	});

	it("seeds from the parent's memory beside its transcript, excluding .runs/", () => {
		const parentFile = writeSessionFile("parent");
		const parentRoot = sessionFileMemoryRoot(parentFile);
		mkdirSync(join(parentRoot, ".runs"), { recursive: true });
		writeFileSync(join(parentRoot, "auth.md"), "---\nid: auth\n---\nbody", "utf-8");
		writeFileSync(join(parentRoot, "JOURNEY.md"), "## history", "utf-8");
		writeFileSync(join(parentRoot, ".runs", "obs-1.cost.json"), "{}", "utf-8");

		const root = ensureSessionMemory(fakeCtx("child", { parentSession: parentFile }));
		expect(readFileSync(join(root, "auth.md"), "utf-8")).toContain("body");
		expect(readFileSync(join(root, "JOURNEY.md"), "utf-8")).toBe("## history");
		expect(existsSync(join(root, ".runs"))).toBe(false);
		// Seeding copies; the parent keeps its memory.
		expect(existsSync(join(parentRoot, "auth.md"))).toBe(true);
	});

	it("seeds from a not-yet-migrated parent's legacy root without moving it", () => {
		const parentFile = writeSessionFile("parent");
		writeLegacy(legacySessionMemoryRoot(cwd, "parent"));
		const root = ensureSessionMemory(fakeCtx("child", { parentSession: parentFile }));
		expect(readFileSync(join(root, "auth.md"), "utf-8")).toContain("legacy body");
		expect(existsSync(legacySessionMemoryRoot(cwd, "parent"))).toBe(true);
	});

	it("is idempotent: an existing root is never re-seeded or overwritten by legacy", () => {
		const parentFile = writeSessionFile("parent");
		mkdirSync(sessionFileMemoryRoot(parentFile), { recursive: true });
		writeFileSync(join(sessionFileMemoryRoot(parentFile), "auth.md"), "parent copy", "utf-8");
		writeLegacy(legacySessionMemoryRoot(cwd, "child"));

		const ctx = fakeCtx("child", { parentSession: parentFile });
		const childRoot = sessionFileMemoryRoot(ctx.sessionManager.getSessionFile()!);
		mkdirSync(childRoot, { recursive: true });
		writeFileSync(join(childRoot, "auth.md"), "child copy", "utf-8");

		const root = ensureSessionMemory(ctx);
		expect(readFileSync(join(root, "auth.md"), "utf-8")).toBe("child copy");
		// The conflicting legacy root is left for the operator, never silently merged or deleted.
		expect(existsSync(legacySessionMemoryRoot(cwd, "child"))).toBe(true);
	});

	it("creates an empty root when the parent kept no memory", () => {
		const parentFile = writeSessionFile("parent");
		const root = ensureSessionMemory(fakeCtx("child", { parentSession: parentFile }));
		expect(existsSync(root)).toBe(true);
	});

	it("uses the ephemeral root for a session without a transcript", () => {
		const root = ensureSessionMemory(fakeCtx(`eph-${process.pid}-${Date.now()}`, { sessionFile: null }));
		try {
			expect(root).toContain("pi-om-ephemeral");
			expect(existsSync(root)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe(".runs cleanup", () => {
	function runsRoot(): string {
		const root = join(temp, "mem");
		mkdirSync(join(root, ".runs"), { recursive: true });
		return root;
	}

	it("removeRunFiles deletes only that run's files", () => {
		const root = runsRoot();
		for (const f of ["obs-1.prompt.md", "obs-1.result.json", "obs-1.cost.json", "obs-12.prompt.md"]) {
			writeFileSync(join(root, ".runs", f), "x", "utf-8");
		}
		removeRunFiles(root, "obs-1");
		expect(existsSync(join(root, ".runs", "obs-1.prompt.md"))).toBe(false);
		expect(existsSync(join(root, ".runs", "obs-1.cost.json"))).toBe(false);
		expect(existsSync(join(root, ".runs", "obs-12.prompt.md"))).toBe(true);
	});

	it("sweepStaleRuns removes files older than the cutoff and keeps recent ones", () => {
		const root = runsRoot();
		const old = join(root, ".runs", "obs-old.prompt.md");
		const fresh = join(root, ".runs", "obs-new.prompt.md");
		writeFileSync(old, "x", "utf-8");
		writeFileSync(fresh, "x", "utf-8");
		const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
		utimesSync(old, twoDaysAgo, twoDaysAgo);
		expect(sweepStaleRuns(root)).toBe(1);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});

	it("sweepStaleRuns is a no-op without a .runs dir", () => {
		expect(sweepStaleRuns(join(temp, "nothing"))).toBe(0);
	});
});
