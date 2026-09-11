import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	OM_OBSERVATIONS_RECORDED,
	fullProjection,
	latestCoverageMarkerId,
	type Entry,
} from "./ledger/index.js";
import { renderSummary } from "./ledger/render.js";
import { renderMemoryMap } from "./memory/index-render.js";
import { listTopics, readJourney } from "./memory/paths.js";
import type { Runtime } from "./runtime.js";

/** Cross-extension request emitted by the 0mux /handoff extension. */
export const OM_PREPARE_HANDOFF_EVENT = "observational-memory:prepare-handoff";
/** One-shot replacement-session state, set only after the handoff draft is accepted. */
export const OM_HANDOFF_ENABLED_ENV = "PI_OM_HANDOFF_ENABLED";
export const OM_HANDOFF_NAME_ENV = "PI_OM_HANDOFF_SESSION_NAME";

export type OmHandoffProjection = {
	/** The same deterministic journey/map/observation block used by OM compaction. */
	summary: string;
	/** Last source entry represented by observations; later source messages stay verbatim. */
	coveredUpToId?: string;
};

export type OmHandoffRequest = {
	enabled?: boolean;
	prepare?: (ctx: any) => Promise<OmHandoffProjection>;
};

export function consumeHandoffEnvironment(): { enabled: boolean; name?: string } {
	const enabled = process.env[OM_HANDOFF_ENABLED_ENV] === "1";
	const name = process.env[OM_HANDOFF_NAME_ENV]?.trim() || undefined;
	delete process.env[OM_HANDOFF_ENABLED_ENV];
	delete process.env[OM_HANDOFF_NAME_ENV];
	return { enabled, name };
}

/**
 * Produce a transactional handoff projection without committing a compaction to the old
 * session. This preserves /handoff's cancel contract while reusing OM's authoritative memory
 * renderer. Observer coverage determines the boundary; everything newer remains verbatim.
 */
export async function projectForHandoff(runtime: Runtime, ctx: any): Promise<OmHandoffProjection> {
	await runtime.whenObserversIdle();
	const branch = ctx.sessionManager.getBranch() as Entry[];
	const summary = renderSummary(
		readJourney(runtime.memoryRoot),
		renderMemoryMap(listTopics(runtime.memoryRoot)),
		fullProjection(branch).observations,
	);
	return {
		summary,
		coveredUpToId: latestCoverageMarkerId(branch, OM_OBSERVATIONS_RECORDED),
	};
}

/**
 * Advertise OM handoff preparation only while this session is enabled and active. OM remains
 * the sole owner of observer settling, coverage boundaries, and deterministic rendering.
 */
export function registerHandoffBridge(pi: ExtensionAPI, runtime: Runtime): void {
	pi.events.on(OM_PREPARE_HANDOFF_EVENT, (value: unknown) => {
		if (!runtime.enabled || runtime.config.passive || typeof value !== "object" || value === null) return;
		const request = value as OmHandoffRequest;
		request.enabled = true;
		request.prepare = (ctx) => projectForHandoff(runtime, ctx);
	});
}
