import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type FileEntry,
	JsonlSessionStorage,
	SessionManager,
	type SessionStorage,
} from "../../src/core/session-manager.ts";
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

	function pendingResult(harness: Harness): ToolResultMessage {
		const result: ToolResultMessage = {
			role: "toolResult",
			toolName: "delayed",
			toolCallId: "call-1",
			content: [{ type: "text", text: "Pending external work" }],
			isError: false,
			timestamp: 1,
			details: { status: "pending" },
		};
		harness.sessionManager.appendMessage(
			fauxAssistantMessage(
				[
					{ ...fauxToolCall("delayed", {}), id: result.toolCallId },
					{ ...fauxToolCall("sibling", {}), id: "call-2" },
				],
				{ stopReason: "toolUse" },
			),
		);
		harness.sessionManager.appendMessage(result);
		harness.sessionManager.appendMessage({
			...result,
			toolName: "sibling",
			toolCallId: "call-2",
			isError: true,
			content: [{ type: "text", text: "Cancelled" }],
			details: undefined,
		});
		harness.sessionManager.appendCustomEntry("example:metadata", { count: 1 });
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		return structuredClone(result);
	}

	it("records a delayed native result, resumes without input or re-execution, and retains audit history", async () => {
		const delivered: string[] = [];
		const harness = await restored({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role === "toolResult") delivered.push(event.message.toolCallId);
					});
					pi.on("input", () => {
						throw new Error("No new user input");
					});
					pi.on("before_agent_start", () => {
						throw new Error("No new prompt");
					});
				},
			],
		});
		const pending = pendingResult(harness);
		const original = structuredClone(harness.sessionManager.getEntries());
		const result = {
			...pending,
			timestamp: 2,
			content: [{ type: "text" as const, text: "Completed" }],
			details: { status: "done" },
		};
		harness.setResponses([
			(context) => {
				const results = context.messages.filter((message) => message.role === "toolResult");
				expect(results.map((message) => message.toolCallId)).toEqual(["call-2", "call-1"]);
				expect(results.at(-1)).toEqual(result);
				return fauxAssistantMessage("Finished");
			},
		]);
		await harness.session.continue(result);
		expect(harness.sessionManager.getEntries().slice(0, original.length)).toEqual(original);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
		).toHaveLength(3);
		expect(getUserTexts(harness)).toEqual(["Saved request"]);
		expect(delivered).toEqual(["call-1"]);
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(0);
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(0);
		expect(harness.eventsOfType("message_end").filter((event) => event.message.role === "toolResult")).toHaveLength(
			1,
		);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		const reloaded = SessionManager.inMemory(
			harness.tempDir,
			undefined,
			JSON.parse(JSON.stringify([harness.sessionManager.getHeader(), ...harness.sessionManager.getEntries()])),
		);
		expect(reloaded.buildSessionContext().messages).toEqual(harness.session.messages);
		expect(harness.session.getSessionStats().toolCalls).toBe(2);
	});

	it.each(["wrong-call", "wrong-name", "completed", "later-user", "abandoned"])(
		"refuses a delayed result for %s without changing history or emitting delivery",
		async (variant) => {
			const harness = await restored();
			const root = harness.sessionManager.getLeafId()!;
			const result = pendingResult(harness);
			if (variant === "wrong-call") result.toolCallId = "missing";
			if (variant === "wrong-name") result.toolName = "another";
			if (variant === "completed") harness.sessionManager.appendMessage(fauxAssistantMessage("Done"));
			if (variant === "later-user")
				harness.sessionManager.appendMessage({ role: "user", content: "Another task", timestamp: 4 });
			if (variant === "abandoned") harness.sessionManager.branch(root);
			const before = structuredClone(harness.sessionManager.getEntries());
			await expect(
				harness.session.continue({ ...result, content: [{ type: "text", text: "Late result" }] }),
			).rejects.toThrow(/selected terminal tool batch/);
			expect(harness.sessionManager.getEntries()).toEqual(before);
			expect(harness.events).toHaveLength(0);
			expect(harness.faux.state.callCount).toBe(0);
		},
	);

	it("retains a delivered result when authentication prevents continuation", async () => {
		const harness = await restored({ withConfiguredAuth: false });
		const pending = pendingResult(harness);
		const result = {
			...pending,
			content: [{ type: "text" as const, text: "Already completed externally" }],
			timestamp: 2,
		};
		await expect(harness.session.continue(result)).rejects.toThrow(/API key/);
		expect(harness.sessionManager.getLeafEntry()).toMatchObject({ type: "message", message: result });
		expect(harness.session.messages.at(-1)).toEqual(result);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.isIdle).toBe(true);
	});

	it("refuses ambiguous call IDs without selecting a result by name", async () => {
		const harness = await restored();
		const pending = pendingResult(harness);
		harness.sessionManager.appendMessage(
			fauxAssistantMessage([
				{ ...fauxToolCall("other", {}), id: pending.toolCallId },
				{ ...fauxToolCall(pending.toolName, {}), id: pending.toolCallId },
			]),
		);
		harness.sessionManager.appendMessage(pending);
		harness.sessionManager.appendMessage({ ...pending, timestamp: 3 });
		const before = structuredClone(harness.sessionManager.getEntries());
		expect(
			harness.sessionManager
				.buildSessionContext()
				.messages.filter((message) => message.role === "toolResult" && message.toolCallId === pending.toolCallId),
		).toHaveLength(3);
		await expect(harness.session.continue(pending)).rejects.toThrow(/selected terminal tool batch/);
		expect(harness.sessionManager.getEntries()).toEqual(before);
		expect(harness.events).toHaveLength(0);
	});

	it("owns delivery while native message hooks run and persists their replacement", async () => {
		let enterHook = () => {};
		let releaseHook = () => {};
		const entered = new Promise<void>((resolve) => {
			enterHook = resolve;
		});
		const released = new Promise<void>((resolve) => {
			releaseHook = resolve;
		});
		const harness = await restored({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role !== "toolResult") return;
						enterHook();
						await released;
						return { message: { ...event.message, details: { transformed: true } } };
					});
				},
			],
		});
		const pending = pendingResult(harness);
		const result = { ...pending, timestamp: 2, details: { external: true } };
		harness.setResponses([fauxAssistantMessage("Finished")]);
		const delivery = harness.session.continue(result);
		try {
			await entered;
			expect(harness.session.isIdle).toBe(false);
			await expect(harness.session.continue(result)).rejects.toThrow(/already processing/);
			result.content = [{ type: "text", text: "Caller mutation" }];
		} finally {
			releaseHook();
			await delivery;
		}
		const delivered = harness.eventsOfType("message_end").find((event) => event.message.role === "toolResult")!;
		expect(delivered.message).toMatchObject({ content: pending.content, details: { transformed: true } });
		expect(harness.sessionManager.buildSessionContext().messages).toEqual(harness.session.messages);
		expect(result.details).toEqual({ external: true });
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	for (const backend of ["records", "jsonl"] as const) {
		it(`delivers after ${backend} restart and recovers from a rejected storage write`, async () => {
			const setup = await restored();
			const records = new Map<string, FileEntry[]>();
			const base: SessionStorage =
				backend === "jsonl"
					? new JsonlSessionStorage(join(setup.tempDir, "sessions"), { deferUntilAssistant: false })
					: {
							createReference: (header) => header.id,
							load: (reference) => structuredClone(records.get(reference)),
							write(reference, entries, mode) {
								if (mode === "create" && records.has(reference)) throw new Error("Already exists");
								records.set(
									reference,
									structuredClone(mode === "append" ? [...records.get(reference)!, ...entries] : [...entries]),
								);
							},
						};
			let failWrites = false;
			const storage: SessionStorage = {
				createReference: (header) => base.createReference(header),
				load: (reference) => base.load(reference),
				write(reference, entries, mode) {
					if (failWrites) throw new Error("Storage unavailable");
					base.write(reference, entries, mode);
				},
			};
			const manager = SessionManager.withStorage(setup.tempDir, storage);
			const first = await restored({ sessionManager: manager });
			const pending = pendingResult(first);
			const before = structuredClone(manager.getEntries());
			first.session.dispose();
			const reopened = manager.openSession(manager.getSessionReference()!);
			const second = await createHarness({ sessionManager: reopened, settings: { compaction: { enabled: false } } });
			harnesses.push(second);
			const result = {
				...pending,
				timestamp: 2,
				content: [{ type: "text" as const, text: "External result" }],
				isError: true,
			};
			second.setResponses([fauxAssistantMessage("The tool failed; report it.")]);
			failWrites = true;
			await expect(second.session.continue(result)).rejects.toThrow("Storage unavailable");
			expect(reopened.getEntries()).toEqual(before);
			expect(second.session.messages).toEqual(manager.buildSessionContext().messages);
			expect(second.faux.state.callCount).toBe(0);
			failWrites = false;
			await second.session.continue(result);
			expect(second.faux.state.callCount).toBe(1);
			const third = reopened.openSession(reopened.getSessionReference()!);
			expect(third.getSessionId()).toBe(manager.getSessionId());
			expect(third.getEntries().slice(0, before.length)).toEqual(before);
			expect(third.buildSessionContext().messages).toEqual(second.session.messages);
			expect(
				third
					.buildSessionContext()
					.messages.filter((message) => message.role === "toolResult" && message.toolCallId === result.toolCallId),
			).toEqual([result]);
		});
	}

	it("delivers the result once across native inference retries", async () => {
		const harness = await restored({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } });
		const pending = pendingResult(harness);
		const before = harness.sessionManager.getEntries().length;
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("Recovered"),
		]);
		await harness.session.continue({ ...pending, timestamp: 2, content: [{ type: "text", text: "Done" }] });
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("message_end").filter((event) => event.message.role === "toolResult")).toHaveLength(
			1,
		);
		expect(
			harness.sessionManager
				.getEntries()
				.slice(before)
				.filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
		).toHaveLength(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("resolves updated results within a batch, never across another batch or branch", async () => {
		const harness = await restored();
		const first = pendingResult(harness);
		const oldLeaf = harness.sessionManager.getLeafId()!;
		harness.sessionManager.appendMessage({
			...first,
			timestamp: 2,
			content: [{ type: "text", text: "First completed" }],
		});
		const updated = harness.sessionManager.getLeafId()!;
		pendingResult(harness);
		expect(
			harness.sessionManager
				.buildSessionContext()
				.messages.filter((message) => message.role === "toolResult" && message.toolCallId === first.toolCallId),
		).toMatchObject([{ content: [{ text: "First completed" }] }, { content: [{ text: "Pending external work" }] }]);
		harness.sessionManager.branch(oldLeaf);
		expect(
			harness.sessionManager
				.buildSessionContext()
				.messages.filter((message) => message.role === "toolResult" && message.toolCallId === first.toolCallId),
		).toEqual([first]);
		harness.sessionManager.branch(updated);
		const assistant = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
		harness.sessionManager.appendCompaction("Earlier context", assistant.id, 100);
		expect(
			harness.sessionManager
				.buildSessionContext()
				.messages.filter((message) => message.role === "toolResult" && message.toolCallId === first.toolCallId),
		).toMatchObject([{ content: [{ text: "First completed" }] }]);
	});

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
