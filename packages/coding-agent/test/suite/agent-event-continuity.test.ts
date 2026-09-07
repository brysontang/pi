import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, getApiProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEventRouter, type LocalAgentEventChannel } from "../../src/core/agent-events.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Test host policy, not another runtime: stable addresses select native session
// files. Each wake creates a new SessionManager and an ordinary Pi runtime.
function createScope(onStart?: (address: string, pi: ExtensionAPI, signal: AbortSignal) => Promise<void>) {
	const participants = new Map<
		string,
		{
			fixture: Harness;
			reference?: string;
			api?: ExtensionAPI;
			runtime?: AgentSessionRuntime;
			channel?: LocalAgentEventChannel;
			starts: number;
		}
	>();
	const errors: string[] = [];
	const router = new AgentEventRouter({ resolveRecipient: open });

	async function open(address: string, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		let participant = participants.get(address);
		if (!participant) {
			participant = {
				fixture: await createHarness({
					settings: { compaction: { enabled: false }, retry: { enabled: false } },
				}),
				starts: 0,
			};
			participants.set(address, participant);
		}
		const current = participant;
		if (current.runtime) throw new Error(`Already running: ${address}`);
		const { fixture } = current;
		const streams = getApiProvider(fixture.faux.api);
		if (!streams) throw new Error("Faux provider is missing");
		const directory = join(fixture.tempDir, "sessions");
		mkdirSync(directory, { recursive: true });
		const manager = current.reference
			? SessionManager.open(current.reference, directory)
			: SessionManager.create(fixture.tempDir, directory);
		const channel = router.connect(address);
		current.channel = channel;
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime: fixture.session.modelRuntime,
				settingsManager: fixture.settingsManager,
				resourceLoaderOptions: {
					agentEvents: channel,
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					extensionFactories: [
						(pi) => {
							current.api = pi;
							pi.registerProvider(fixture.getModel().provider, {
								baseUrl: fixture.getModel().baseUrl,
								apiKey: "faux-key",
								api: fixture.faux.api,
								models: fixture.models,
								streamSimple: streams.streamSimple,
							});
							pi.on("session_start", async () => {
								current.starts++;
								await onStart?.(address, pi, signal);
							});
							pi.on("agent_event", (event) => {
								if (event.customType !== "example:message") return;
								if (typeof event.data !== "string") throw new Error("Expected message text");
								fixture.appendResponses([fauxAssistantMessage(`received:${event.data}`)]);
								// The extension selects native turn/steering behavior. Routing does
								// not turn arbitrary events into model input or infer a reply target.
								pi.sendMessage(
									{
										customType: event.customType,
										content: event.data,
										display: true,
										details: { from: event.from },
									},
									{ triggerTurn: true, deliverAs: "steer" },
								);
							});
						},
					],
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: fixture.getModel(),
					tools: [],
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		try {
			current.runtime = await createAgentSessionRuntime(createRuntime, {
				cwd: fixture.tempDir,
				agentDir: fixture.tempDir,
				sessionManager: manager,
			});
			await current.runtime.session.bindExtensions({ onError: (error) => errors.push(error.error) });
			signal.throwIfAborted();
			current.reference = manager.getSessionFile();
		} catch (error) {
			await stop(address);
			throw error;
		}
	}

	async function stop(address: string): Promise<void> {
		const current = participants.get(address)!;
		current.channel?.close();
		await current.runtime?.session.abort();
		await current.runtime?.dispose();
		current.runtime = undefined;
		current.api = undefined;
	}

	cleanups.push(async () => {
		router.close();
		for (const [address, participant] of participants) {
			await stop(address);
			participant.fixture.cleanup();
		}
	});
	return {
		participants,
		errors,
		router,
		stop,
		start: (address: string) => open(address, new AbortController().signal),
		message: (from: string, to: string, text: string) =>
			participants.get(from)!.api!.sendAgentEvent(to, "example:message", text),
		async received(address: string, text: string) {
			const session = participants.get(address)!.runtime!.session;
			await expect
				.poll(() => session.messages.filter((message) => message.role === "assistant").map(getMessageText))
				.toContain(`received:${text}`);
			await session.waitForIdle();
		},
	};
}

describe("addressed events across native runtime lifetimes", () => {
	it("allows ordinary session_start extensions to exchange events during concurrent wakes", async () => {
		const starting: string[] = [];
		const received: string[][] = [];
		let bothStarting!: () => void;
		const started = new Promise<void>((resolve) => {
			bothStarting = resolve;
		});
		const scope = createScope(async (address, pi, signal) => {
			if (address === "a") return;
			pi.on("agent_event", (event) => {
				if (event.customType === "example:starting") received.push([event.from, event.to]);
			});
			starting.push(address);
			if (starting.length === 2) bothStarting();
			await started;
			await Promise.race([
				pi.sendAgentEvent(address === "b" ? "c" : "b", "example:starting"),
				new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
			]);
		});
		await scope.start("a");
		const pending = Promise.all([scope.message("a", "b", "request to b"), scope.message("a", "c", "request to c")]);
		const settled = pending.then(
			() => true,
			() => false,
		);
		try {
			await expect.poll(() => received.length, { timeout: 5000 }).toBe(2);
			await pending;
			await scope.received("b", "request to b");
			await scope.received("c", "request to c");
			expect(received.sort()).toEqual([
				["b", "c"],
				["c", "b"],
			]);
			expect(scope.participants.get("b")!.starts).toBe(1);
			expect(scope.participants.get("c")!.starts).toBe(1);
			expect(scope.errors).toEqual([]);
		} finally {
			scope.router.close();
			await settled;
		}
	}, 30_000);

	it("restores B on a later A-to-B message and lets C wake A in its original history", async () => {
		const scope = createScope();
		await scope.start("a");
		await scope.message("a", "b", "first request");
		await scope.received("b", "first request");
		await scope.message("b", "a", "first result");
		await scope.received("a", "first result");
		const firstB = scope.participants.get("b")!.runtime!.session;
		const firstA = scope.participants.get("a")!.runtime!.session;
		const bEntries = firstB.sessionManager.getEntries();
		await scope.stop("b");
		await scope.message("a", "b", "second request");
		await scope.received("b", "second request");
		const nextB = scope.participants.get("b")!.runtime!.session;
		expect(nextB).not.toBe(firstB);
		expect(nextB.sessionManager).not.toBe(firstB.sessionManager);
		expect(nextB.sessionManager.getSessionId()).toBe(firstB.sessionManager.getSessionId());
		expect(nextB.sessionManager.getEntries().slice(0, bEntries.length)).toEqual(bEntries);
		expect(nextB.messages.map(getMessageText)).toEqual([
			"first request",
			"received:first request",
			"second request",
			"received:second request",
		]);
		await scope.message("b", "c", "request to c");
		await scope.received("c", "request to c");
		await scope.stop("a");
		await scope.message("c", "a", "cycle result");
		await scope.received("a", "cycle result");
		const nextA = scope.participants.get("a")!.runtime!.session;
		expect(nextA).not.toBe(firstA);
		expect(nextA.sessionManager.getSessionId()).toBe(firstA.sessionManager.getSessionId());
		expect(nextA.messages.map(getMessageText)).toEqual([
			"first result",
			"received:first result",
			"cycle result",
			"received:cycle result",
		]);
		const persisted = SessionManager.open(nextA.sessionFile!);
		expect(persisted.getEntries()).toEqual(nextA.sessionManager.getEntries());
		expect(scope.errors).toEqual([]);
	}, 30_000);

	it("keeps equal addresses in different scopes isolated and preserves native extension reload", async () => {
		const first = createScope();
		const second = createScope();
		await first.start("a");
		await second.start("a");
		await first.message("a", "b", "private to first scope");
		await first.received("b", "private to first scope");
		await second.message("a", "b", "private to second scope");
		await second.received("b", "private to second scope");
		const firstB = first.participants.get("b")!;
		const secondB = second.participants.get("b")!;
		expect(firstB.reference).not.toBe(secondB.reference);
		expect(secondB.runtime!.session.messages.map(getMessageText)).toEqual([
			"private to second scope",
			"received:private to second scope",
		]);
		const oldApi = firstB.api!;
		await firstB.runtime!.session.reload();
		expect(firstB.starts).toBe(2);
		await expect(oldApi.sendAgentEvent("a", "example:message", "stale")).rejects.toThrow("stale");
		await first.message("a", "b", "after reload");
		await first.received("b", "after reload");
		expect(
			firstB.runtime!.session.messages.filter((message) => getMessageText(message) === "after reload"),
		).toHaveLength(1);
		expect(secondB.starts).toBe(1);
		expect(secondB.runtime!.session.messages).toHaveLength(2);
		expect([...first.errors, ...second.errors]).toEqual([]);
	}, 30_000);
});
