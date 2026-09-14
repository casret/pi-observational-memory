/**
 * Observational memory — ORCHESTRATOR (master-side, in-process).
 *
 * The conductor: owns the clocks/triggers, spawns subprocess workers, commits their output to
 * the ledger (observations) or files (long-term, Phase B), renders compaction, and drives the
 * TUI. Event-driven only — no daemon.
 *
 * Enabled by default for sessions without an explicit ledger gate. `/om off` persists an
 * authoritative opt-out; when off, every handler returns at its first line and the extension
 * is completely invisible.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactCommand } from "./commands/compact.js";
import { registerConsolidateCommand } from "./commands/consolidate.js";
import { registerStatusCommand } from "./commands/status.js";
import {
	consumeHandoffEnvironment,
	registerHandoffBridge,
} from "./handoff.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidatorTrigger } from "./hooks/consolidator-trigger.js";
import { registerObserverTrigger } from "./hooks/observer-trigger.js";
import { OM_ENABLED, type Entry } from "./ledger/index.js";
import { syncMemoryNameIndex } from "./memory/name-index.js";
import { sessionMemoryRoot } from "./memory/paths.js";
import { ensureSessionMemory } from "./memory/session.js";
import { Runtime } from "./runtime.js";

export const DEFAULT_ENABLED = true;

export function readGateFromLedger(branch: Entry[]): boolean | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === OM_ENABLED) {
			const enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled;
			return typeof enabled === "boolean" ? enabled : undefined;
		}
	}
	return undefined;
}

export default function observationalMemory(pi: ExtensionAPI): void {
	const runtime = new Runtime();

	function attachIfEnabled(ctx: any): void {
		if (runtime.enabled && ctx.mode === "tui" && ctx.hasUI && ctx.ui) {
			runtime.status.attach(ctx.ui);
		} else {
			runtime.status.detach();
		}
	}

	function syncFriendlyIndex(ctx: any, name = pi.getSessionName()): void {
		const sessionId = ctx.sessionManager.getSessionId();
		syncMemoryNameIndex(sessionMemoryRoot(ctx.cwd, sessionId), sessionId, name);
	}

	pi.on("session_start", (_event: unknown, ctx: any) => {
		runtime.ensureConfig(ctx.cwd);
		runtime.dispatchedCoversUpToId = undefined;

		// /handoff creates a deliberately blank child session, so its normal setup callback runs
		// too late for session_start. Consume the one-shot state here, persist the gate in the new
		// ledger, and let ensureSessionMemory seed from the parent before the kickoff turn starts.
		const { enabled: inheritedFromHandoff, name: inheritedName } = consumeHandoffEnvironment();

		let branch = ctx.sessionManager.getBranch() as Entry[];
		const ledgerEnabled = readGateFromLedger(branch);
		runtime.enabled = ledgerEnabled ?? (inheritedFromHandoff || DEFAULT_ENABLED);
		if (inheritedFromHandoff && ledgerEnabled === undefined) {
			pi.appendEntry(OM_ENABLED, { enabled: true });
			branch = ctx.sessionManager.getBranch() as Entry[];
		}
		if (runtime.enabled) runtime.memoryRoot = ensureSessionMemory(ctx);
		syncFriendlyIndex(ctx, inheritedName);
		attachIfEnabled(ctx);
		runtime.refreshFooterGauges(branch, ctx.getContextUsage?.());
		runtime.refreshCost(ctx.sessionManager.getEntries() as Entry[]);
	});

	// Pi 0.85 added this event; the package's broad peer range intentionally keeps older dev
	// types, so declare only the runtime overload we use instead of pulling a new dependency tree.
	const sessionInfoEvents = pi as unknown as {
		on(event: "session_info_changed", handler: (event: { name?: string }, ctx: any) => void): void;
	};
	sessionInfoEvents.on("session_info_changed", (event, ctx) => {
		syncFriendlyIndex(ctx, event.name);
	});

	pi.on("session_shutdown", () => {
		runtime.status.detach();
		runtime.abortAllWorkers();
	});

	pi.registerCommand("om", {
		description: "Toggle observational memory for this session (/om on, /om off)",
		handler: async (args: string, ctx: any) => {
			const arg = (args ?? "").trim().toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !runtime.enabled;
			if (next === runtime.enabled) {
				if (ctx.hasUI) ctx.ui.notify(`om already ${next ? "on" : "off"}`, "info");
				return;
			}
			runtime.enabled = next;
			pi.appendEntry(OM_ENABLED, { enabled: next });
			if (next) {
				runtime.memoryRoot = ensureSessionMemory(ctx);
				syncFriendlyIndex(ctx);
				attachIfEnabled(ctx);
				runtime.refreshFooterGauges(ctx.sessionManager.getBranch() as Entry[], ctx.getContextUsage?.());
				runtime.refreshCost(ctx.sessionManager.getEntries() as Entry[]);
			} else {
				runtime.abortAllWorkers();
				runtime.status.detach();
			}
			if (ctx.hasUI) ctx.ui.notify(`om ${next ? "enabled" : "disabled"}`, "info");
		},
	});

	// Triggers + hook self-gate on runtime.enabled / passive at their first line.
	registerObserverTrigger(pi, runtime);
	registerConsolidatorTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);
	registerHandoffBridge(pi, runtime);

	registerStatusCommand(pi, runtime);
	registerCompactCommand(pi, runtime);
	registerConsolidateCommand(pi, runtime);
}
