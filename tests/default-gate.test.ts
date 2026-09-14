import { describe, expect, it } from "vitest";
import { DEFAULT_ENABLED, readGateFromLedger } from "../src/index.js";
import type { Entry } from "../src/ledger/index.js";

function gate(id: string, enabled: unknown): Entry {
	return { type: "custom", id, customType: "om.enabled", data: { enabled } };
}

describe("default OM gate", () => {
	it("enables sessions with no explicit gate", () => {
		expect(DEFAULT_ENABLED).toBe(true);
		expect(readGateFromLedger([]) ?? DEFAULT_ENABLED).toBe(true);
	});

	it("preserves the latest explicit opt-out or opt-in", () => {
		expect(readGateFromLedger([gate("on", true), gate("off", false)])).toBe(false);
		expect(readGateFromLedger([gate("off", false), gate("on", true)])).toBe(true);
	});

	it("does not treat malformed gate data as an opt-out", () => {
		expect(readGateFromLedger([gate("bad", "false")])).toBeUndefined();
	});
});
