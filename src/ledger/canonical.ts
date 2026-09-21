import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Entry } from "./types.js";

export type ProjectedEntryLike = {
	sourceEntry: { id: string };
	messages: AgentMessage[];
};

export type ProjectionSessionManager = {
	getBranch(): Entry[];
	buildSessionProjection?: () => { entries: ProjectedEntryLike[] };
};

function canProduceSource(entry: Entry): boolean {
	return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}

/**
 * Overlay Pi's canonical, context-edit-aware messages onto the raw branch.
 *
 * The raw branch remains necessary for OM's append-only ledger, coverage markers, and
 * compaction details. `buildSessionProjection()` is authoritative only for model-visible
 * source content: entries omitted by compaction or `context_edit` receive an empty projected
 * message list, while replacements retain the original source-entry id as their watermark.
 */
export function canonicalizeBranch(branch: Entry[], projectedEntries: ProjectedEntryLike[]): Entry[] {
	const messagesBySourceId = new Map(
		projectedEntries.map((entry) => [entry.sourceEntry.id, entry.messages] as const),
	);

	return branch.map((entry) => {
		if (!canProduceSource(entry)) return entry;
		return {
			...entry,
			projectedMessages: messagesBySourceId.get(entry.id) ?? [],
		};
	});
}

/** Return the current raw ledger branch with canonical model-visible source overlays. */
export function canonicalBranch(sessionManager: ProjectionSessionManager): Entry[] {
	const branch = sessionManager.getBranch();
	const projection = sessionManager.buildSessionProjection?.();
	if (!projection || !Array.isArray(projection.entries)) return branch;
	return canonicalizeBranch(branch, projection.entries);
}
