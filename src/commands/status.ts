import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { postCompactionBaselines } from "../compaction-metrics.js";
import { activeContextWindow, effectiveCompactionThreshold } from "../compaction-threshold.js";
import {
	canonicalBranch,
	foldLedger,
	poolTokens,
	rawTokensSinceObservationCoverage,
	sumSessionCost,
	type Entry,
} from "../ledger/index.js";
import { listTopics, readJourney } from "../memory/paths.js";
import { estimateStringTokens } from "../tokens.js";
import type { Runtime } from "../runtime.js";
import { renderTimeline } from "../ui/timeline.js";

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:status", {
		description: "Show observational-memory status (workers, buffer, clocks)",
		handler: async (_args: string, ctx: any) => {
			if (!ctx.hasUI) return;
			if (!runtime.enabled) {
				ctx.ui.notify("om is off (use /om on to enable)", "info");
				return;
			}
			runtime.ensureConfig(ctx.cwd);
			const branch = canonicalBranch(ctx.sessionManager);
			const folded = foldLedger(branch);
			const sinceObservation = rawTokensSinceObservationCoverage(branch);
			const contextTokens = ctx.getContextUsage?.()?.tokens ?? null;
			const contextWindow = activeContextWindow(ctx);
			const effectiveCompactionAt = effectiveCompactionThreshold(
				contextWindow,
				runtime.config.compactBeforeContextEndTokens,
				runtime.config.compactAtContextTokens,
			);
			const baselines = postCompactionBaselines(branch);
			const baselineText = baselines.length
				? `${baselines.map((item) => item.requestContextTokens.toLocaleString()).join(" → ")} tok (oldest → newest)`
				: "none yet";
			const pool = poolTokens(folded.activeObservations);
			const topicCount = listTopics(runtime.memoryRoot).length;
			const journey = readJourney(runtime.memoryRoot);
			const { costUsd, runs } = sumSessionCost(ctx.sessionManager.getEntries() as Entry[]);

			const lines = [
				`om status`,
				`  observers in flight: ${runtime.observersInFlight.size} / ${runtime.config.observerConcurrency}`,
				`  active observations: ${folded.activeObservations.length}`,
				`  next observer: ${sinceObservation.toLocaleString()} / ${runtime.config.chunkTokens.toLocaleString()} tok`,
				`  pool: ${pool.toLocaleString()} tok (target ${runtime.config.poolTargetTokens.toLocaleString()}, consolidate at ${runtime.config.consolidateAtPoolTokens.toLocaleString()})`,
				`  consolidator: ${runtime.consolidatorInFlight ? "running" : "idle"}`,
				`  last compaction wait: ${runtime.lastCompactionObserverWait ?? "n/a"}`,
				`  topic files: ${topicCount}`,
				`  journey: ${journey ? `~${estimateStringTokens(journey).toLocaleString()} / ${runtime.config.journeyTargetTokens.toLocaleString()} tok` : "none yet"}`,
				`  context: ${contextTokens != null ? contextTokens.toLocaleString() : "?"} / ${effectiveCompactionAt.toLocaleString()} tok effective` +
					(contextWindow
						? ` (model ${contextWindow.toLocaleString()}, margin ${runtime.config.compactBeforeContextEndTokens.toLocaleString()})`
						: ` (window unavailable; legacy fallback)`),
				`  post-compaction request context: ${baselineText}`,
				`  session cost: $${costUsd.toFixed(4)} (${runs} run${runs === 1 ? "" : "s"})`,
				runtime.lastWorkerError ? `  last error: ${runtime.lastWorkerError}` : `  last error: none`,
				"",
				renderTimeline(branch, runtime.config),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
