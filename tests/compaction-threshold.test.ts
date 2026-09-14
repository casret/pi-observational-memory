import { describe, expect, it } from "vitest";
import { activeContextWindow, effectiveCompactionThreshold } from "../src/compaction-threshold.js";

describe("effectiveCompactionThreshold", () => {
	it("keeps a fixed absolute margin across short and long model windows", () => {
		expect(effectiveCompactionThreshold(272_000, 50_000, 150_000)).toBe(222_000);
		expect(effectiveCompactionThreshold(1_000_000, 50_000, 150_000)).toBe(950_000);
		expect(effectiveCompactionThreshold(1_048_576, 50_000, 150_000)).toBe(998_576);
	});

	it("uses the legacy threshold when the active context window is unavailable", () => {
		expect(effectiveCompactionThreshold(undefined, 50_000, 800_000)).toBe(800_000);
		expect(effectiveCompactionThreshold(0, 50_000, 800_000)).toBe(800_000);
		expect(effectiveCompactionThreshold(Number.NaN, 50_000, 800_000)).toBe(800_000);
	});

	it("clamps pathological margins to a usable positive threshold", () => {
		expect(effectiveCompactionThreshold(32_000, 50_000, 150_000)).toBe(1);
	});
});

describe("activeContextWindow", () => {
	it("prefers live usage metadata and falls back to the active model", () => {
		expect(activeContextWindow({ getContextUsage: () => ({ contextWindow: 272_000 }), model: { contextWindow: 1_000_000 } })).toBe(272_000);
		expect(activeContextWindow({ getContextUsage: () => undefined, model: { contextWindow: 1_000_000 } })).toBe(1_000_000);
	});
});
