import { describe, expect, it } from "vitest";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import { Runtime } from "../src/runtime.js";
import { compactionEntry, rawMessage } from "./fixtures/session.js";

function register(runtime: Runtime): (event: unknown, ctx: any) => void {
	let handler: ((event: unknown, ctx: any) => void) | undefined;
	registerCompactionTrigger({
		on: (event: string, candidate: typeof handler) => {
			if (event === "turn_end") handler = candidate;
		},
		sendMessage: () => undefined,
	} as any, runtime);
	expect(handler).toBeTypeOf("function");
	return handler!;
}

describe("model-aware compaction trigger", () => {
	it("recomputes the absolute-margin threshold when the active model window changes", () => {
		const runtime = new Runtime();
		runtime.enabled = true;
		let usage = { tokens: 222_000, contextWindow: 272_000 };
		let compactions = 0;
		const handler = register(runtime);
		const ctx = {
			getContextUsage: () => usage,
			sessionManager: { getBranch: () => [] },
			hasUI: false,
			compact: (options: { onComplete: () => void }) => {
				compactions += 1;
				options.onComplete();
			},
		};

		handler({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, ctx);
		expect(compactions).toBe(1);

		usage = { tokens: 222_000, contextWindow: 1_000_000 };
		handler({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, ctx);
		expect(compactions).toBe(1);

		usage = { tokens: 950_000, contextWindow: 1_000_000 };
		handler({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, ctx);
		expect(compactions).toBe(2);
	});

	it("does not request a duplicate when no source entry follows the latest compaction", () => {
		const runtime = new Runtime();
		runtime.enabled = true;
		let compactions = 0;
		const handler = register(runtime);
		const branch = [
			rawMessage("raw-1", "x".repeat(1000)),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
		];
		const ctx = {
			getContextUsage: () => ({ tokens: 950_000, contextWindow: 1_000_000 }),
			sessionManager: { getBranch: () => branch },
			hasUI: false,
			compact: () => {
				compactions += 1;
			},
		};

		handler({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, ctx);
		expect(compactions).toBe(0);
	});

	it("treats Pi's Already compacted rejection as idempotent", () => {
		const runtime = new Runtime();
		runtime.enabled = true;
		const notifications: string[] = [];
		const handler = register(runtime);
		const ctx = {
			getContextUsage: () => ({ tokens: 950_000, contextWindow: 1_000_000 }),
			sessionManager: { getBranch: () => [rawMessage("raw-1", "x".repeat(1000))] },
			hasUI: true,
			ui: { notify: (message: string) => notifications.push(message) },
			compact: (options: { onError: (error: { message: string }) => void }) => {
				options.onError({ message: "Already compacted" });
			},
		};

		handler({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, ctx);
		expect(runtime.compactInFlight).toBe(false);
		expect(notifications.some((message) => message.includes("Already compacted"))).toBe(false);
	});

	it("still resumes a mid-run compaction when Pi's own compaction already covered it", () => {
		const runtime = new Runtime();
		runtime.enabled = true;
		const sent: any[] = [];
		let handler: ((event: unknown, ctx: any) => void) | undefined;
		registerCompactionTrigger({
			on: (event: string, candidate: typeof handler) => { if (event === "turn_end") handler = candidate; },
			sendMessage: (message: unknown) => sent.push(message),
		} as any, runtime);
		const notifications: string[] = [];
		const ctx = {
			getContextUsage: () => ({ tokens: 950_000, contextWindow: 1_000_000 }),
			sessionManager: { getBranch: () => [rawMessage("raw-1", "x".repeat(1000))] },
			hasUI: true,
			ui: { notify: (message: string) => notifications.push(message) },
			compact: (options: { onError: (error: { message: string }) => void }) => {
				options.onError({ message: "Nothing to compact (session too small)" });
			},
		};

		handler!({ message: { role: "assistant", stopReason: "toolUse" }, toolResults: [{}] }, ctx);
		expect(runtime.compactInFlight).toBe(false);
		expect(sent).toHaveLength(1);
		expect(notifications.some((message) => message.includes("Nothing to compact"))).toBe(false);
	});
});

describe("Pi threshold compaction is owned by OM", () => {
	function hook(runtime: Runtime) {
		let handler: ((event: unknown, ctx: any) => Promise<unknown>) | undefined;
		registerCompactionHook({
			on: (event: string, candidate: typeof handler) => { if (event === "session_before_compact") handler = candidate; },
		} as any, runtime);
		return handler!;
	}

	it("cancels Pi's threshold compaction while OM is on", async () => {
		const runtime = new Runtime();
		runtime.enabled = true;
		expect(await hook(runtime)({ reason: "threshold" }, { hasUI: false })).toEqual({ cancel: true });
	});

	it("leaves threshold compaction alone when OM is off", async () => {
		const runtime = new Runtime();
		runtime.enabled = false;
		expect(await hook(runtime)({ reason: "threshold" }, { hasUI: false })).toBeUndefined();
	});

	it("does not cancel OM's own in-flight compaction, even if tagged threshold", async () => {
		const runtime = new Runtime();
		runtime.enabled = true;
		runtime.compactInFlight = true;
		const result: any = await hook(runtime)(
			{ reason: "threshold", preparation: { firstKeptEntryId: "x", tokensBefore: 1 }, branchEntries: [] },
			{ hasUI: false, cwd: "/tmp", sessionManager: { getBranch: () => [] } },
		).catch(() => ({ proceeded: true }));
		expect(result?.cancel).not.toBe(true);
	});
});
