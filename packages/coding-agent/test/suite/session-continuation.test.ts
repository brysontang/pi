import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness, type HarnessOptions } from "./harness.ts";

describe("AgentSession continuation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function restored(options: HarnessOptions = {}): Promise<Harness> {
		const harness = await createHarness({
			...options,
			settings: { compaction: { enabled: false }, ...options.settings },
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "Saved request", timestamp: Date.now() });
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		return harness;
	}

	it("uses native retries and emits settled without manufacturing a new input", async () => {
		const inputEvents: string[] = [];
		const harness = await restored({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("input", () => {
						inputEvents.push("input");
					});
					pi.on("before_agent_start", () => {
						inputEvents.push("before_agent_start");
					});
					pi.on("agent_settled", () => {
						inputEvents.push("agent_settled");
					});
				},
			],
		});
		const idleDuringInference: boolean[] = [];
		harness.setResponses([
			() => {
				idleDuringInference.push(harness.session.isIdle);
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
			},
			() => {
				idleDuringInference.push(harness.session.isIdle);
				return fauxAssistantMessage("Recovered");
			},
		]);

		await harness.session.continue();

		expect(idleDuringInference).toEqual([false, false]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(inputEvents).toEqual(["agent_settled"]);
		expect(getUserTexts(harness)).toEqual(["Saved request"]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "message")).toHaveLength(3);
		expect(harness.session.getLastAssistantText()).toBe("Recovered");
		expect(harness.session.isIdle).toBe(true);
	});

	it("drains follow-ups queued by agent_end extensions before settling", async () => {
		let queued = false;
		const harness = await restored({
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
		harness.setResponses([fauxAssistantMessage("First"), fauxAssistantMessage("Finished")]);

		await harness.session.continue();

		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)).toEqual(["Saved request", "Follow through"]);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("uses native overflow compaction and retries the interrupted response", async () => {
		const harness = await restored({
			models: [{ id: "small", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Earlier work summarized",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		// A completed earlier turn gives Pi history to summarize while keeping
		// the latest request available for the interrupted response.
		harness.sessionManager.appendMessage(fauxAssistantMessage("Earlier answer"));
		harness.sessionManager.appendMessage({ role: "user", content: "Next request", timestamp: Date.now() });
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			fauxAssistantMessage("Recovered after compaction"),
		]);

		await harness.session.continue();

		expect(harness.eventsOfType("compaction_end")).toMatchObject([
			{ reason: "overflow", aborted: false, willRetry: true },
		]);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.getLastAssistantText()).toBe("Recovered after compaction");
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("rejects a concurrent continuation without settling the active run", async () => {
		const harness = await restored();
		let enterResponse = () => {};
		let releaseResponse = () => {};
		const entered = new Promise<void>((resolve) => {
			enterResponse = resolve;
		});
		const released = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		harness.setResponses([
			async () => {
				enterResponse();
				await released;
				return fauxAssistantMessage("Finished");
			},
		]);
		const pending = harness.session.continue();
		try {
			await entered;
			await expect(harness.session.continue()).rejects.toThrow(/already processing/);
			expect(harness.session.isIdle).toBe(false);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(0);
			let idleResolved = false;
			const idle = harness.session.waitForIdle().then(() => {
				idleResolved = true;
			});
			await Promise.resolve();
			expect(idleResolved).toBe(false);
			releaseResponse();
			await idle;
		} finally {
			releaseResponse();
			await pending;
		}
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.session.isIdle).toBe(true);
	});

	it("aborts native retry backoff and waits for the resumed run to settle", async () => {
		const harness = await restored({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 10_000 } } });
		const retryStarted = new Promise<void>((resolve) => {
			harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") resolve();
			});
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("Must not run"),
		]);
		const pending = harness.session.continue();
		await retryStarted;
		await harness.session.abort();
		await pending;
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, finalError: "Retry cancelled" }]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.session.isIdle).toBe(true);
	});

	it("rejects unconfigured authentication before inference", async () => {
		const harness = await restored({ withConfiguredAuth: false });
		await expect(harness.session.continue()).rejects.toThrow(/API key/);
		expect(harness.faux.state.callCount).toBe(0);
		expect(getUserTexts(harness)).toEqual(["Saved request"]);
		expect(harness.session.isIdle).toBe(true);
	});

	it("preserves the core continuation precondition for a completed assistant response", async () => {
		const harness = await restored();
		harness.sessionManager.appendMessage(fauxAssistantMessage("Already done"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		await expect(harness.session.continue()).rejects.toThrow(/Cannot continue from message role: assistant/);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.isIdle).toBe(true);
	});
});
