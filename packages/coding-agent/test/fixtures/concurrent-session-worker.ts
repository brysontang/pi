import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { createAgentEventPeer } from "../../src/core/agent-event-ipc.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/index.ts";
import { createHarness, getAssistantTexts, getUserTexts } from "../suite/harness.ts";

// Test-only IPC driver. Agent execution, tools, reload and history remain native Pi.
export type ProbeCommand =
	| {
			action:
				| "inspect"
				| "start"
				| "release"
				| "abort"
				| "reload"
				| "local"
				| "dispose"
				| "dispose-session"
				| "stale-send";
	  }
	| { action: "report"; to: string }
	| { action: "send"; to: string; text: string };

export interface ProbeSnapshot {
	pid: number;
	identity: string;
	cwd: string;
	sessionId: string;
	instance: number;
	localEvents: number;
	received: { from: string; text: string }[];
	users: string[];
	assistants: string[];
	customEntries: { customType: string; data?: unknown }[];
	streaming: boolean;
	providerCalls: number;
	activeTools: string[];
	staleApiRejected: boolean;
	extensionErrors: string[];
}

export type ProbeReply =
	| { type: "ready"; snapshot: ProbeSnapshot }
	| { type: "result"; id: number; snapshot: ProbeSnapshot }
	| { type: "error"; id: number; message: string };

function send(message: ProbeReply): void {
	if (!process.send) throw new Error("Concurrency fixture requires IPC");
	process.send(message);
}

async function main(): Promise<void> {
	const identity = process.env.PI_CONCURRENCY_TEST_AGENT;
	if (!identity) throw new Error("Concurrency fixture requires an identity");
	// Reuse the suite's offline provider/credential fixtures, but exercise the SDK's
	// real session construction and per-runtime provider dispatch in each worker.
	const fixture = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
	});
	const fauxStreams = getApiProvider(fixture.faux.api);
	if (!fauxStreams) throw new Error("The test harness did not register its faux provider");
	const eventBus = createEventBus();
	const peer = createAgentEventPeer();
	let instance = 0;
	let readExtension = () => ({ instance: 0, localEvents: 0, received: [] as { from: string; text: string }[] });
	let firstApi: ExtensionAPI | undefined;
	let currentApi: ExtensionAPI | undefined;
	let entered: (() => void) | undefined;
	let release: (() => void) | undefined;
	let run: Promise<void> | undefined;
	let runFailure: unknown;
	let disposed = false;
	let reportTo: string | undefined;
	const extensionErrors: string[] = [];

	// Every worker loads this same extension. Factory and process state are independent.
	const factory: ExtensionFactory = (pi) => {
		pi.registerProvider(fixture.getModel().provider, {
			baseUrl: fixture.getModel().baseUrl,
			apiKey: "faux-key",
			api: fixture.faux.api,
			models: fixture.models,
			streamSimple: fauxStreams.streamSimple,
		});
		const ordinal = ++instance;
		let localEvents = 0;
		const received: { from: string; text: string }[] = [];
		firstApi ??= pi;
		currentApi = pi;
		readExtension = () => ({ instance: ordinal, localEvents, received: [...received] });
		pi.on("session_start", () => pi.appendEntry("test:instance", { ordinal }));
		pi.on("agent_settled", async (_event, ctx) => {
			if (reportTo)
				await pi.sendAgentEvent(reportTo, "test:finished", { sessionId: ctx.sessionManager.getSessionId() });
		});
		pi.events.on("test:local", () => localEvents++);
		pi.on("agent_event", (incoming) => {
			if (incoming.customType === "test:finished") {
				pi.appendEntry("test:finished", incoming.data);
				return;
			}
			if (incoming.customType !== "test:incoming") return;
			const data = incoming.data as { text: string };
			if (data.text === "handler-error") throw new Error("deliberate agent event handler failure");
			const event = { from: incoming.from, text: data.text };
			received.push(event);
			pi.appendEntry("test:received", event);
		});
		pi.registerTool({
			name: "hold",
			label: "Hold",
			description: "Wait for the test to release this agent.",
			parameters: Type.Object({}),
			async execute(_id, _args, signal) {
				await new Promise<void>((resolve) => {
					const finish = () => {
						signal?.removeEventListener("abort", finish);
						release = undefined;
						resolve();
					};
					release = finish;
					signal?.addEventListener("abort", finish, { once: true });
					entered?.();
					if (signal?.aborted) finish();
				});
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		});
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		settingsManager: fixture.settingsManager,
		eventBus,
		agentEvents: peer.channel,
		extensionFactories: [factory],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	fixture.session.dispose();
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		model: fixture.getModel(),
		modelRuntime: fixture.session.modelRuntime,
		sessionManager: fixture.sessionManager,
		settingsManager: fixture.settingsManager,
		resourceLoader,
		tools: ["hold"],
	});
	const harness = { ...fixture, session };
	harness.session.subscribe(() => {});
	await harness.session.bindExtensions({
		shutdownHandler: () => {},
		onError: (error) => extensionErrors.push(error.error),
	});

	const snapshot = (): ProbeSnapshot => {
		let staleApiRejected = false;
		try {
			firstApi?.getActiveTools();
		} catch {
			staleApiRejected = true;
		}
		return {
			pid: process.pid,
			identity,
			cwd: process.cwd(),
			sessionId: harness.sessionManager.getSessionId(),
			...readExtension(),
			users: getUserTexts(harness),
			assistants: getAssistantTexts(harness),
			customEntries: harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom")
				.map((entry) => ({ customType: entry.customType, data: entry.data })),
			streaming: harness.session.isStreaming,
			providerCalls: harness.faux.state.callCount,
			activeTools: harness.session.getActiveToolNames(),
			staleApiRejected,
			extensionErrors: [...extensionErrors],
		};
	};

	const execute = async (command: ProbeCommand): Promise<void> => {
		switch (command.action) {
			case "inspect":
				break;
			case "start": {
				if (run) throw new Error("A run is already active");
				const toolEntered = new Promise<void>((resolve) => {
					entered = resolve;
				});
				harness.setResponses([
					fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
					fauxAssistantMessage(`done:${identity}`),
				]);
				runFailure = undefined;
				run = harness.session.prompt(`work:${identity}`).catch((error: unknown) => {
					runFailure = error;
				});
				await Promise.race([
					toolEntered,
					run.then(() => {
						throw runFailure ?? new Error("Agent finished before entering the hold tool");
					}),
				]);
				break;
			}
			case "release":
				release?.();
				await run;
				run = undefined;
				if (runFailure) throw runFailure;
				break;
			case "abort":
				await harness.session.abort();
				await run;
				run = undefined;
				break;
			case "reload":
				await harness.session.reload();
				break;
			case "local":
				eventBus.emit("test:local", undefined);
				break;
			case "send":
				await currentApi!.sendAgentEvent(command.to, "test:incoming", { text: command.text });
				break;
			case "report":
				reportTo = command.to;
				break;
			case "stale-send":
				await firstApi!.sendAgentEvent("right", "test:incoming", { text: "stale" });
				break;
			case "dispose":
			case "dispose-session":
				await harness.session.abort();
				await run;
				harness.session.dispose();
				harness.cleanup();
				disposed = true;
				if (command.action === "dispose") peer.close();
				break;
		}
	};
	process.on("message", (message: { id: number; command: ProbeCommand }) => {
		if (!message.command) return;
		void execute(message.command).then(
			() => send({ type: "result", id: message.id, snapshot: snapshot() }),
			(error: unknown) =>
				send({ type: "error", id: message.id, message: error instanceof Error ? error.message : String(error) }),
		);
	});
	process.once("disconnect", () => {
		if (!disposed) {
			harness.session.dispose();
			harness.cleanup();
		}
		process.exit(0);
	});
	send({ type: "ready", snapshot: snapshot() });
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
