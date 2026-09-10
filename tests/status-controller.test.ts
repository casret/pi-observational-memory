import { describe, expect, it, vi } from "vitest";

import { StatusController, type StatusUI } from "../src/ui/status-controller.js";

function fakeUI() {
	const status = new Map<string, string | undefined>();
	const widgets: Array<string[] | undefined> = [];
	const ui: StatusUI = {
		setStatus: (key, text) => status.set(key, text),
		setWidget: (_key, content) => widgets.push(content),
		// Strip color so assertions read the raw glyphs.
		theme: { fg: (_color, text) => text },
	};
	return { ui, footer: () => status.get("om"), widgets };
}

describe("StatusController cost-only footer", () => {
	it("shows a bare footer until cost is known", () => {
		const { ui, footer } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		expect(footer()).toBe("om");
	});

	it("keeps running-worker status static", () => {
		vi.useFakeTimers();
		try {
			const { ui, widgets } = fakeUI();
			const sc = new StatusController();
			sc.attach(ui);
			sc.workerStart("observer", "run-1");
			expect(widgets).toEqual([["◐ [observer]"]]);
			vi.advanceTimersByTime(1000);
			expect(widgets).toEqual([["◐ [observer]"]]);
			sc.detach();
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders session spend but not token gauges", () => {
		const { ui, footer } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		sc.setGauges({ nextValue: 1500, nextMax: 3000, poolValue: 5000, poolMax: 10_000, ctxValue: 10_000, ctxMax: 80_000 });
		expect(footer()).toBe("om");
		sc.setCost(5.7696, 42);
		expect(footer()).toBe("om $5.770");
		sc.setGauges(undefined);
		expect(footer()).toBe("om $5.770");
	});
});
