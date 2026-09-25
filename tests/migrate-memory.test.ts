import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "scripts", "migrate-memory.mjs");
let temp: string;
let agentDir: string;
let project: string;

const old = (path: string) => {
	const t = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
	utimesSync(path, t, t);
};

function session(id: string, cwd = project): string {
	const dir = join(agentDir, "sessions", "--project--");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-09-25T00-00-00-000Z_${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", id, cwd })}\n`);
	old(file);
	return file;
}

function legacy(id: string, body = "memory"): string {
	const root = join(project, ".memory", id);
	mkdirSync(join(root, ".runs"), { recursive: true });
	writeFileSync(join(root, "topic.md"), body);
	writeFileSync(join(root, ".runs", "x.prompt.md"), "transient");
	return root;
}

const run = (...args: string[]) =>
	execFileSync(process.execPath, [SCRIPT, "--json", ...args], {
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		encoding: "utf8",
	});

beforeEach(() => {
	temp = mkdtempSync(join(tmpdir(), "om-migrate-"));
	agentDir = join(temp, "agent");
	project = join(temp, "project");
	mkdirSync(project, { recursive: true });
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));

describe("migrate-memory.mjs", () => {
	it("plans without changing anything by default", () => {
		const file = session("aaa");
		const root = legacy("aaa");
		const plan = JSON.parse(run());
		expect(plan.move.map((m: { target: string }) => m.target)).toEqual([file.replace(/\.jsonl$/, ".memory")]);
		expect(existsSync(root)).toBe(true);
	});

	it("--apply moves roots, drops .runs, repoints links, removes empty orphans and dangling links", () => {
		const file = session("aaa");
		legacy("aaa", "kept body");
		mkdirSync(join(project, ".memory", "no-transcript-empty"), { recursive: true });
		legacy("no-transcript-full", "orphan body"); // non-empty orphan: must be kept
		const index = join(agentDir, "om-memory");
		mkdirSync(index, { recursive: true });
		symlinkSync(join(project, ".memory", "aaa"), join(index, "named--aaa"));
		symlinkSync(join(temp, "gone", ".memory", "zzz"), join(index, "gone--zzz"));
		symlinkSync(join(project, ".memory", "no-transcript-empty"), join(index, "empty--nnn"));

		run("--apply");

		const target = file.replace(/\.jsonl$/, ".memory");
		expect(readFileSync(join(target, "topic.md"), "utf8")).toBe("kept body");
		expect(existsSync(join(target, ".runs"))).toBe(false);
		expect(existsSync(join(project, ".memory", "aaa"))).toBe(false);
		expect(existsSync(join(project, ".memory", "no-transcript-empty"))).toBe(false);
		expect(readFileSync(join(project, ".memory", "no-transcript-full", "topic.md"), "utf8")).toBe("orphan body");
		expect(readlinkSync(join(index, "named--aaa"))).toBe(target);
		expect(() => lstatSync(join(index, "gone--zzz"))).toThrow();
		// Links to removed empty orphans are cleaned up in the same pass.
		expect(() => lstatSync(join(index, "empty--nnn"))).toThrow();
	});

	it("skips sessions with recent transcript activity and never overwrites an existing target", () => {
		const live = session("live");
		writeFileSync(live, readFileSync(live, "utf8")); // fresh mtime
		legacy("live");
		const conflicted = session("both");
		legacy("both", "legacy copy");
		mkdirSync(conflicted.replace(/\.jsonl$/, ".memory"));
		writeFileSync(join(conflicted.replace(/\.jsonl$/, ".memory"), "topic.md"), "new copy");

		const plan = JSON.parse(run("--apply"));
		expect(plan.live.map((m: { sessionId: string }) => m.sessionId)).toEqual(["live"]);
		expect(plan.conflict.map((m: { sessionId: string }) => m.sessionId)).toEqual(["both"]);
		expect(existsSync(join(project, ".memory", "live", "topic.md"))).toBe(true);
		expect(readFileSync(join(project, ".memory", "both", "topic.md"), "utf8")).toBe("legacy copy");
		expect(readFileSync(join(conflicted.replace(/\.jsonl$/, ".memory"), "topic.md"), "utf8")).toBe("new copy");
	});
});
