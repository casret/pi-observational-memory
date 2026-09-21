import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	canonicalizeBranch,
	foldLedger,
	isSourceEntry,
	rawTokensSinceObservationCoverage,
	selectSourceSlice,
	serializeSourceAddressedBranchEntries,
	type Entry,
} from "../src/ledger/index.js";
import {
	branchSummary,
	customMessage,
	observation,
	observationsRecordedEntry,
	rawMessage,
} from "./fixtures/session.js";

function projected(sourceEntry: { id: string }, messages: AgentMessage[]) {
	return { sourceEntry, messages };
}

function user(content: string): AgentMessage {
	return { role: "user", content, timestamp: Date.now() };
}

describe("canonical source projection", () => {
	it("uses replacement content and excludes omitted attempts while retaining source ids", () => {
		const original = rawMessage("m-original", "ORIGINAL CONTENT");
		const failed = rawMessage("m-failed", "FAILED RETRY ATTEMPT");
		const next = rawMessage("m-next", "next request");
		const branch = [
			original,
			failed,
			{ type: "context_edit", id: "edit-failed", parentId: null, timestamp: "2026-01-01", data: null },
			next,
		] as Entry[];
		const canonical = canonicalizeBranch(branch, [
			projected(original, [user("replacement content")]),
			projected(failed, []),
			projected(next, [user("next request")]),
		]);

		expect(isSourceEntry(canonical[0])).toBe(true);
		expect(isSourceEntry(canonical[1])).toBe(false);
		const slice = selectSourceSlice(canonical, undefined, 10_000);
		expect(slice.entries.map((entry) => entry.id)).toEqual(["m-original", "m-next"]);
		expect(slice.coversUpToId).toBe("m-next");

		const serialized = serializeSourceAddressedBranchEntries(slice.entries).text;
		expect(serialized).toContain("replacement content");
		expect(serialized).toContain("[Source entry id: m-original]");
		expect(serialized).not.toContain("ORIGINAL CONTENT");
		expect(serialized).not.toContain("FAILED RETRY ATTEMPT");
	});

	it("keeps branch-local ledger records while excluding compacted-away raw sources", () => {
		const old = rawMessage("m-old", "old raw history");
		const recorded = observationsRecordedEntry("obs", {
			observations: [observation("2026-01-01T00:00:00")],
			coversUpToId: old.id,
		});
		const retained = rawMessage("m-retained", "retained tail");
		const compaction = {
			type: "compaction",
			id: "compact",
			parentId: null,
			timestamp: "2026-01-01",
			firstKeptEntryId: retained.id,
			summary: "memory",
		};
		const branch = [old, recorded, retained, compaction] as Entry[];
		const canonical = canonicalizeBranch(branch, [
			projected(compaction, [{ role: "compactionSummary", summary: "memory", tokensBefore: 10, timestamp: 0 }]),
			projected(retained, [user("retained tail")]),
		]);

		expect(isSourceEntry(canonical[0])).toBe(false);
		expect(foldLedger(canonical).activeObservations).toHaveLength(1);
		expect(rawTokensSinceObservationCoverage(canonical)).toBeGreaterThan(0);
		expect(serializeSourceAddressedBranchEntries(selectSourceSlice(canonical, old.id, 10_000).entries).text)
			.toContain("retained tail");
	});

	it("serializes projected custom and branch-summary content and ignores system messages", () => {
		const custom = customMessage("custom", "old custom");
		const summary = branchSummary("summary", "old summary");
		const system = rawMessage("system", "old system", {
			message: { role: "system", content: "operative prompt", timestamp: Date.now() },
		});
		const canonical = canonicalizeBranch([custom, summary, system] as Entry[], [
			projected(custom, [{ role: "custom", customType: "notice", content: "new custom", display: false, timestamp: 0 }]),
			projected(summary, [{ role: "branchSummary", summary: "new summary", fromId: "m1", timestamp: 0 }]),
			projected(system, [{ role: "system", content: "operative prompt", timestamp: 0 }]),
		]);

		expect(isSourceEntry(canonical[2])).toBe(false);
		const text = serializeSourceAddressedBranchEntries(canonical).text;
		expect(text).toContain("new custom");
		expect(text).toContain("new summary");
		expect(text).not.toContain("old custom");
		expect(text).not.toContain("old summary");
		expect(text).not.toContain("operative prompt");
	});
});
