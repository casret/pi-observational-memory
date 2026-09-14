import { describe, expect, it } from "vitest";
import { postCompactionBaselines } from "../src/compaction-metrics.js";
import { compactionEntry, memoryDetails, rawMessage, type TestEntry } from "./fixtures/session.js";

function assistant(id: string, usage: Record<string, number>, overrides: Record<string, unknown> = {}): TestEntry {
	return rawMessage(id, "assistant", {
		message: {
			role: "assistant",
			provider: "openai",
			model: "gpt-test",
			stopReason: "stop",
			usage,
			...overrides,
		},
	});
}

function omCompaction(id: string): TestEntry {
	return compactionEntry(id, { details: memoryDetails() });
}

describe("postCompactionBaselines", () => {
	it("derives the first successful request-input context after each OM compaction", () => {
		const entries = [
			omCompaction("c1"),
			assistant("failed", { input: 999 }, { stopReason: "error" }),
			assistant("a1", { input: 3, cacheRead: 40_000, cacheWrite: 2_000, output: 100 }),
			rawMessage("u2", "more work"),
			omCompaction("c2"),
			assistant("a2", { input: 2, cacheRead: 50_000, cacheWrite: 1_000, output: 200 }),
		] as TestEntry[];

		expect(postCompactionBaselines(entries as any)).toEqual([
			expect.objectContaining({ compactionId: "c1", requestContextTokens: 42_003, provider: "openai", model: "gpt-test" }),
			expect.objectContaining({ compactionId: "c2", requestContextTokens: 51_002, provider: "openai", model: "gpt-test" }),
		]);
	});

	it("limits output to the newest baselines and ignores non-OM compactions", () => {
		const entries = [
			omCompaction("c1"),
			assistant("a1", { totalTokens: 10_100, output: 100 }),
			compactionEntry("native"),
			assistant("native-a", { input: 99_000 }),
			omCompaction("c2"),
			assistant("a2", { totalTokens: 20_200, output: 200 }),
			omCompaction("c3"),
			assistant("a3", { totalTokens: 30_300, output: 300 }),
		] as TestEntry[];

		expect(postCompactionBaselines(entries as any, 2).map((item) => item.requestContextTokens)).toEqual([20_000, 30_000]);
	});

	it("returns no baseline for invalid limits or missing provider usage", () => {
		const entries = [omCompaction("c1"), assistant("a1", {})] as TestEntry[];
		expect(postCompactionBaselines(entries as any)).toEqual([]);
		expect(postCompactionBaselines(entries as any, 0)).toEqual([]);
	});
});
