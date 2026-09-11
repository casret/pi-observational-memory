import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	OM_HANDOFF_ENABLED_ENV,
	OM_HANDOFF_NAME_ENV,
	OM_PREPARE_HANDOFF_EVENT,
	consumeHandoffEnvironment,
	projectForHandoff,
	registerHandoffBridge,
	type OmHandoffRequest,
} from "../src/handoff.js";
import { Runtime } from "../src/runtime.js";
import { observation, observationsRecordedEntry, rawMessage } from "./fixtures/session.js";

const tempRoots: string[] = [];

afterEach(() => {
	delete process.env[OM_HANDOFF_ENABLED_ENV];
	delete process.env[OM_HANDOFF_NAME_ENV];
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OM handoff bridge", () => {
	it("offers the canonical projection only for an enabled active session", async () => {
		const runtime = new Runtime();
		runtime.enabled = true;
		runtime.memoryRoot = mkdtempSync(join(tmpdir(), "om-handoff-test-"));
		tempRoots.push(runtime.memoryRoot);
		let listener: ((request: OmHandoffRequest) => void) | undefined;
		const pi = {
			events: {
				on: vi.fn((event: string, handler: (request: OmHandoffRequest) => void) => {
					expect(event).toBe(OM_PREPARE_HANDOFF_EVENT);
					listener = handler;
				}),
			},
		};
		registerHandoffBridge(pi as never, runtime);

		const request: OmHandoffRequest = {};
		listener?.(request);
		expect(request.enabled).toBe(true);
		expect(request.prepare).toBeTypeOf("function");

		const whenIdle = vi.spyOn(runtime, "whenObserversIdle");
		const projection = await request.prepare?.({ sessionManager: { getBranch: () => [] } });
		expect(whenIdle).toHaveBeenCalledOnce();
		expect(projection).toEqual({ summary: "", coveredUpToId: undefined });
	});

	it("stays invisible while OM is off or passive", () => {
		const runtime = new Runtime();
		let listener: ((request: OmHandoffRequest) => void) | undefined;
		registerHandoffBridge({ events: { on: (_event: string, handler: typeof listener) => { listener = handler; } } } as never, runtime);
		const off: OmHandoffRequest = {};
		listener?.(off);
		expect(off).toEqual({});

		runtime.enabled = true;
		runtime.config.passive = true;
		const passive: OmHandoffRequest = {};
		listener?.(passive);
		expect(passive).toEqual({});
	});

	it("renders observed history and returns its exact source boundary", async () => {
		const runtime = new Runtime();
		runtime.memoryRoot = mkdtempSync(join(tmpdir(), "om-handoff-test-"));
		tempRoots.push(runtime.memoryRoot);
		const branch = [
			rawMessage("raw-1", "old"),
			observationsRecordedEntry("om-1", {
				observations: [observation("2026-09-11T18:00:00", { content: "Remember the completed migration" })],
				coversUpToId: "raw-1",
			}),
			rawMessage("raw-2", "unobserved tail"),
		];
		const projection = await projectForHandoff(runtime, {
			sessionManager: { getBranch: () => branch },
		});
		expect(projection.coveredUpToId).toBe("raw-1");
		expect(projection.summary).toContain("Remember the completed migration");
		expect(projection.summary).not.toContain("unobserved tail");
	});

	it("does not render until in-flight observers settle", async () => {
		const runtime = new Runtime();
		vi.spyOn(runtime, "whenObserversIdle").mockRejectedValue(new Error("observer failed"));
		await expect(projectForHandoff(runtime, { sessionManager: { getBranch: () => [] } })).rejects.toThrow(
			"observer failed",
		);
	});

	it("consumes replacement inheritance exactly once", () => {
		process.env[OM_HANDOFF_ENABLED_ENV] = "1";
		process.env[OM_HANDOFF_NAME_ENV] = "  billing-credit  ";
		expect(consumeHandoffEnvironment()).toEqual({ enabled: true, name: "billing-credit" });
		expect(consumeHandoffEnvironment()).toEqual({ enabled: false, name: undefined });
	});
});
