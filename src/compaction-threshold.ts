/**
 * Derive the proactive OM compaction threshold from the active model. The margin only needs to
 * leave operational room for another turn/tool result: OM's compaction renderer is deterministic
 * and does not need to fit the old transcript into a model request.
 *
 * `fallbackThreshold` preserves the old absolute-threshold behavior on Pi versions or contexts
 * that do not expose the active model's context window.
 */
export function effectiveCompactionThreshold(
	contextWindow: number | null | undefined,
	marginTokens: number,
	fallbackThreshold: number,
): number {
	if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
		return fallbackThreshold;
	}
	return Math.max(1, Math.floor(contextWindow) - marginTokens);
}

export function activeContextWindow(ctx: {
	getContextUsage?: () => { contextWindow?: number } | undefined;
	model?: { contextWindow?: number };
}): number | undefined {
	const usageWindow = ctx.getContextUsage?.()?.contextWindow;
	if (typeof usageWindow === "number" && usageWindow > 0) return usageWindow;
	const modelWindow = ctx.model?.contextWindow;
	return typeof modelWindow === "number" && modelWindow > 0 ? modelWindow : undefined;
}
