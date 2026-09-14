import { OM_FOLDED, type Entry } from "./ledger/index.js";

export type PostCompactionBaseline = {
	compactionId: string;
	compactionTimestamp?: string;
	requestContextTokens: number;
	provider?: string;
	model?: string;
};

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Provider-reported input context for one request, excluding that response's output tokens. */
function requestContextTokens(message: Record<string, unknown>): number | undefined {
	const usage = message.usage;
	if (!usage || typeof usage !== "object") return undefined;
	const record = usage as Record<string, unknown>;
	const parts = ["input", "cacheRead", "cacheWrite"].map((key) => finiteNonNegative(record[key]));
	if (parts.some((part) => part !== undefined)) return parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);

	const total = finiteNonNegative(record.totalTokens);
	const output = finiteNonNegative(record.output);
	if (total === undefined || output === undefined || output > total) return undefined;
	return total - output;
}

function isOmCompaction(entry: Entry): boolean {
	if (entry.type !== "compaction" || !entry.details || typeof entry.details !== "object") return false;
	return (entry.details as { type?: unknown }).type === OM_FOLDED;
}

/**
 * Derive the first provider request-input size after each OM compaction from the persisted
 * session branch. No duplicate telemetry is written; these are the same usage records Pi uses
 * for context and cost reporting.
 */
export function postCompactionBaselines(entries: Entry[], limit = 3): PostCompactionBaseline[] {
	if (!Number.isInteger(limit) || limit <= 0) return [];
	const baselines: PostCompactionBaseline[] = [];
	let pending: Entry | undefined;

	for (const entry of entries) {
		if (entry.type === "compaction") {
			pending = isOmCompaction(entry) ? entry : undefined;
			continue;
		}
		if (!pending || entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as Record<string, unknown>;
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
		const tokens = requestContextTokens(message);
		if (tokens === undefined) continue;
		baselines.push({
			compactionId: pending.id,
			compactionTimestamp: pending.timestamp,
			requestContextTokens: tokens,
			provider: typeof message.provider === "string" ? message.provider : undefined,
			model: typeof message.model === "string" ? message.model : undefined,
		});
		pending = undefined;
	}

	return baselines.slice(-limit);
}
