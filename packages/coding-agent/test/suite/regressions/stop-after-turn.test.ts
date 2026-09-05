import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

describe("session honors shouldStopAfterTurn", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	for (const delivery of ["steer", "followUp"] as const) {
		for (const boundary of ["turn_end", "agent_end"] as const) {
			it(`preserves ${delivery} queued at ${boundary} until explicit continuation`, async () => {
				let executions = 0;
				let queued = false;
				const tool: AgentTool = {
					name: "probe",
					label: "Probe",
					description: "Record a side effect.",
					parameters: Type.Object({}),
					async execute() {
						executions++;
						return { content: [{ type: "text", text: "landed" }], details: {} };
					},
				};
				const harness = await createHarness({
					tools: [tool],
					settings: { compaction: { enabled: false } },
					extensionFactories: [
						(pi) => {
							const queueWork = () => {
								if (queued) return;
								queued = true;
								pi.sendUserMessage("Queued work", { deliverAs: delivery });
							};
							if (boundary === "turn_end") pi.on("turn_end", queueWork);
							else pi.on("agent_end", queueWork);
						},
					],
				});
				harnesses.push(harness);
				harness.session.agent.shouldStopAfterTurn = () => true;
				harness.setResponses([
					fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }),
					fauxAssistantMessage("Resumed"),
				]);

				await harness.session.prompt("Work");

				expect(harness.faux.state.callCount).toBe(1);
				expect(executions).toBe(1);
				expect(harness.session.messages.at(-1)?.role).toBe("toolResult");
				expect(harness.session.pendingMessageCount).toBe(1);
				expect(getUserTexts(harness)).toEqual(["Work"]);
				expect(harness.eventsOfType("agent_end")).toHaveLength(1);
				expect(harness.eventsOfType("agent_end")[0]).toMatchObject({ reason: "stop_after_turn", willRetry: false });
				expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
				expect(harness.session.isIdle).toBe(true);

				harness.session.agent.shouldStopAfterTurn = undefined;
				// Follow-ups run after the interrupted task finishes; steering is
				// delivered before its next response.
				if (delivery === "followUp") harness.appendResponses([fauxAssistantMessage("Follow-up done")]);
				await harness.session.continue();
				expect(harness.faux.state.callCount).toBe(delivery === "steer" ? 2 : 3);
				expect(executions).toBe(1);
				expect(getUserTexts(harness)).toEqual(["Work", "Queued work"]);
				expect(harness.session.pendingMessageCount).toBe(0);
				expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
				expect(harness.session.isIdle).toBe(true);
			});
		}
	}

	it("does not compact or restart a stopped run whose last response exceeds the threshold", async () => {
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 50 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					pi.on("session_compact", () => pi.sendUserMessage("Continue work", { deliverAs: "steer" }));
				},
			],
		});
		harnesses.push(harness);
		harness.session.agent.shouldStopAfterTurn = () => true;
		harness.setResponses([
			fauxAssistantMessage([fauxText("x".repeat(8000)), fauxToolCall("unknown", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Must not run"),
		]);
		await harness.session.prompt("Work");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.session.messages.at(-1)?.role).toBe("toolResult");
	});

	it("still continues messages queued at agent_end when no stop was requested", async () => {
		let queued = false;
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", () => {
						if (queued) return;
						queued = true;
						pi.sendUserMessage("Follow through", { deliverAs: "followUp" });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("First response"), fauxAssistantMessage("Follow-up response")]);
		await harness.session.prompt("Work");
		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)).toEqual(["Work", "Follow through"]);
	});
});
