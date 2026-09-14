import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerStatusCommand } from "../src/commands/status.js";
import { Runtime } from "../src/runtime.js";
import { compactionEntry, memoryDetails, rawMessage, type TestEntry } from "./fixtures/session.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("/om:status", () => {
	it("shows the model-aware margin threshold and recent post-compaction baselines", async () => {
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		const pi = {
			registerCommand: (name: string, command: { handler: typeof handler }) => {
				if (name === "om:status") handler = command.handler;
			},
		};
		const runtime = new Runtime();
		runtime.enabled = true;
		runtime.configLoaded = true;
		runtime.memoryRoot = mkdtempSync(join(tmpdir(), "om-status-"));
		roots.push(runtime.memoryRoot);

		const entries = [
			compactionEntry("c1", { details: memoryDetails() }),
			rawMessage("a1", "assistant", {
				message: {
					role: "assistant",
					content: [],
					provider: "openai",
					model: "gpt-test",
					stopReason: "stop",
					usage: { input: 3, cacheRead: 40_000, cacheWrite: 2_000, output: 100 },
				},
			}),
		] as TestEntry[];
		let notification = "";
		registerStatusCommand(pi as any, runtime);
		expect(handler).toBeTypeOf("function");
		await handler!("", {
			hasUI: true,
			cwd: runtime.memoryRoot,
			ui: { notify: (message: string) => { notification = message; } },
			sessionManager: { getBranch: () => entries, getEntries: () => entries },
			getContextUsage: () => ({ tokens: 100_000, contextWindow: 272_000 }),
			model: { contextWindow: 1_000_000 },
		});

		expect(notification).toContain("context: 100,000 / 222,000 tok effective (model 272,000, margin 50,000)");
		expect(notification).toContain("post-compaction request context: 42,003 tok (oldest → newest)");
	});
});
