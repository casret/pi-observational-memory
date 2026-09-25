import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { memoryNameLinkName, safeSessionName, syncMemoryNameIndex } from "../src/memory/name-index.js";

let temp: string;
let indexDir: string;
let memoryRoot: string;

beforeEach(() => {
	temp = mkdtempSync(join(tmpdir(), "om-name-index-"));
	indexDir = join(temp, "central");
	memoryRoot = join(temp, "project", ".memory", "01a04474-full-id");
	mkdirSync(memoryRoot, { recursive: true });
});

afterEach(() => {
	rmSync(temp, { recursive: true, force: true });
});

describe("safeSessionName", () => {
	it("keeps names readable while removing path traversal and control characters", () => {
		expect(safeSessionName("  Connect / webhook\n rollout  ")).toBe("Connect-webhook-rollout");
		expect(safeSessionName("../../")).toBe("unnamed");
		expect(safeSessionName(undefined)).toBe("unnamed");
	});

	it("puts the friendly name first and appends a short immutable id", () => {
		expect(memoryNameLinkName("connect-out", "01a05dd9-170f-78ac")).toBe("connect-out--01a05dd9");
	});
});

describe("syncMemoryNameIndex", () => {
	it("creates a global friendly-name symlink to the canonical memory root", () => {
		const link = syncMemoryNameIndex(memoryRoot, "01a04474-full-id", "0mux", indexDir);
		expect(link).toBe(join(indexDir, "0mux--01a04474"));
		expect(lstatSync(link!).isSymbolicLink()).toBe(true);
		expect(readlinkSync(link!)).toBe(resolve(memoryRoot));
	});

	it("replaces the old friendly-name link when a session is renamed", () => {
		const oldLink = syncMemoryNameIndex(memoryRoot, "01a04474-full-id", "old name", indexDir)!;
		const newLink = syncMemoryNameIndex(memoryRoot, "01a04474-full-id", "new name", indexDir)!;
		expect(existsSync(oldLink)).toBe(false);
		expect(newLink).toBe(join(indexDir, "new-name--01a04474"));
		expect(readlinkSync(newLink)).toBe(resolve(memoryRoot));
	});

	it("keeps same-named sessions distinct by immutable id", () => {
		const otherRoot = join(temp, "other-project", ".memory", "01a05dd9-full-id");
		mkdirSync(otherRoot, { recursive: true });
		const first = syncMemoryNameIndex(memoryRoot, "01a04474-full-id", "0mux", indexDir)!;
		const second = syncMemoryNameIndex(otherRoot, "01a05dd9-full-id", "0mux", indexDir)!;
		expect(first).toBe(join(indexDir, "0mux--01a04474"));
		expect(second).toBe(join(indexDir, "0mux--01a05dd9"));
		expect(readlinkSync(first)).toBe(resolve(memoryRoot));
		expect(readlinkSync(second)).toBe(resolve(otherRoot));
	});

	it("does not overwrite an unrelated path and falls back to the full id", () => {
		mkdirSync(indexDir, { recursive: true });
		writeFileSync(join(indexDir, "same--01a04474"), "leave me alone", "utf-8");
		const link = syncMemoryNameIndex(memoryRoot, "01a04474-full-id", "same", indexDir);
		expect(link).toBe(join(indexDir, "same--01a04474-full-id"));
		expect(readlinkSync(link!)).toBe(resolve(memoryRoot));
	});

	it("removes duplicate stale links that point to the same memory root", () => {
		mkdirSync(indexDir, { recursive: true });
		const stale = join(indexDir, "stale--01a04474");
		symlinkSync(resolve(memoryRoot), stale, "dir");
		const current = syncMemoryNameIndex(memoryRoot, "01a04474-full-id", "current", indexDir)!;
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(current)).toBe(true);
	});

	it("does nothing when the canonical memory root has not been created", () => {
		const missing = join(temp, "missing");
		expect(syncMemoryNameIndex(missing, "session", "name", indexDir)).toBeUndefined();
		expect(existsSync(indexDir)).toBe(false);
	});

	it("reclaims this session's dangling link after its root moved (migration)", () => {
		const sessionId = "01a04474-full-id";
		const legacyRoot = join(temp, "project", ".memory", sessionId); // pre-migration root (now gone)
		mkdirSync(indexDir, { recursive: true });
		symlinkSync(legacyRoot, join(indexDir, "0mux--01a04474"));
		const fullIdLeftover = join(indexDir, `0mux--${sessionId}`);
		rmSync(legacyRoot, { recursive: true, force: true });
		const newRoot = join(temp, "sessions", "--project--", `2026-09-25T00-00-00-000Z_${sessionId}.memory`);
		mkdirSync(newRoot, { recursive: true });
		symlinkSync(newRoot, fullIdLeftover); // fallback link the buggy release created

		const link = syncMemoryNameIndex(newRoot, sessionId, "0mux", indexDir);
		expect(link).toBe(join(indexDir, "0mux--01a04474"));
		expect(readlinkSync(link!)).toBe(resolve(newRoot));
		expect(() => lstatSync(fullIdLeftover)).toThrow();
	});

	it("never reclaims a dangling link that belonged to a different session", () => {
		mkdirSync(indexDir, { recursive: true });
		const foreign = join(indexDir, "0mux--01a04474");
		symlinkSync(join(temp, "gone", ".memory", "01a04474-other-session"), foreign);
		const link = syncMemoryNameIndex(memoryRoot, "01a04474-full-id", "0mux", indexDir);
		expect(link).toBe(join(indexDir, "0mux--01a04474-full-id"));
		expect(readlinkSync(foreign)).toBe(join(temp, "gone", ".memory", "01a04474-other-session"));
	});
});
