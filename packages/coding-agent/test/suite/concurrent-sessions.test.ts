import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentEventPeer } from "../../src/core/agent-event-ipc.ts";
import { AgentEventRouter } from "../../src/core/agent-events.ts";
import type { ProbeCommand, ProbeReply, ProbeSnapshot } from "../fixtures/concurrent-session-worker.ts";

const children: ChildProcess[] = [];
const directories: string[] = [];
const routers: AgentEventRouter[] = [];

afterEach(async () => {
	for (const router of routers.splice(0)) router.close();
	await Promise.all(
		children.splice(0).map(async (child) => {
			if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}),
	);
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function startProbe(identity: string, router: AgentEventRouter) {
	const directory = await mkdtemp(join(tmpdir(), "pi-concurrent-"));
	directories.push(directory);
	const child = fork(fileURLToPath(new URL("../fixtures/concurrent-session-worker.ts", import.meta.url)), [], {
		cwd: directory,
		execArgv: ["--import", fileURLToPath(new URL("../../src/experimental/source-resolver.ts", import.meta.url))],
		env: { PATH: process.env.PATH, PI_OFFLINE: "1", PI_CONCURRENCY_TEST_AGENT: identity },
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	children.push(child);
	const peer = createAgentEventPeer(child);
	peer.onClose(router.attach(identity, peer.connection));
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-16_384);
	});
	child.stdout?.resume();
	let sequence = 0;
	const pending = new Map<number, { resolve: (value: ProbeSnapshot) => void; reject: (error: Error) => void }>();
	let readyResolve!: (value: ProbeSnapshot) => void;
	let readyReject!: (error: Error) => void;
	const ready = new Promise<ProbeSnapshot>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	const fail = (error: Error) => {
		readyReject(error);
		for (const request of pending.values()) request.reject(error);
		pending.clear();
	};
	child.once("error", fail);
	child.once("exit", (code, signal) => fail(new Error(`Probe ${identity} exited (${signal ?? code}): ${stderr}`)));
	child.on("message", (message: ProbeReply) => {
		if (message.type === "ready") readyResolve(message.snapshot);
		else if (message.type === "error" || message.type === "result") {
			const request = pending.get(message.id);
			pending.delete(message.id);
			if (message.type === "error") request?.reject(new Error(message.message));
			else request?.resolve(message.snapshot);
		}
	});
	const initial = await ready;
	return {
		identity,
		initial,
		getStderr: () => stderr,
		request(command: ProbeCommand): Promise<ProbeSnapshot> {
			return new Promise((resolve, reject) => {
				const id = ++sequence;
				pending.set(id, { resolve, reject });
				child.send({ id, command }, (error) => {
					if (!error) return;
					pending.delete(id);
					reject(error);
				});
			});
		},
	};
}

describe("ordinary sessions in separate processes", () => {
	it("keeps extensions and native histories independent while exchanging an explicit event", async () => {
		const router = new AgentEventRouter();
		routers.push(router);
		const [left, right] = await Promise.all([startProbe("left", router), startProbe("right", router)]);
		expect(left.initial.pid).not.toBe(right.initial.pid);
		expect(left.initial.pid).not.toBe(process.pid);
		expect(left.initial.cwd).not.toBe(right.initial.cwd);
		expect(left.initial.sessionId).not.toBe(right.initial.sessionId);
		expect([left.initial.identity, right.initial.identity]).toEqual(["left", "right"]);
		expect([left.initial.instance, right.initial.instance]).toEqual([1, 1]);
		expect([left.initial.activeTools, right.initial.activeTools]).toEqual([["hold"], ["hold"]]);

		const [leftRunning, rightRunning] = await Promise.all([
			left.request({ action: "start" }),
			right.request({ action: "start" }),
		]);
		expect([leftRunning.streaming, rightRunning.streaming]).toEqual([true, true]);
		expect([leftRunning.providerCalls, rightRunning.providerCalls]).toEqual([1, 1]);
		expect(leftRunning.users).toEqual(["work:left"]);
		expect(rightRunning.users).toEqual(["work:right"]);

		expect((await left.request({ action: "local" })).localEvents).toBe(1);
		expect((await right.request({ action: "inspect" })).localEvents).toBe(0);

		await left.request({ action: "send", to: "right", text: "explicit event" });
		const received = await right.request({ action: "inspect" });
		expect(received.received).toEqual([{ from: "left", text: "explicit event" }]);
		expect(received.customEntries.filter((entry) => entry.customType === "test:received")).toEqual([
			{ customType: "test:received", data: { from: "left", text: "explicit event" } },
		]);
		expect(received.users).toEqual(["work:right"]);
		expect((await left.request({ action: "inspect" })).received).toEqual([]);

		const stopped = await left.request({ action: "abort" });
		expect(stopped.streaming).toBe(false);
		const sibling = await right.request({ action: "inspect" });
		expect(sibling.streaming).toBe(true);
		expect(sibling.providerCalls).toBe(1);
		expect(sibling.instance).toBe(1);

		const reloaded = await left.request({ action: "reload" });
		expect(reloaded.instance).toBe(2);
		expect(reloaded.staleApiRejected).toBe(true);
		expect(reloaded.sessionId).toBe(left.initial.sessionId);
		expect(reloaded.users).toEqual(["work:left"]);
		expect(reloaded.activeTools).toEqual(["hold"]);
		expect((await left.request({ action: "local" })).localEvents).toBe(1);
		const unchanged = await right.request({ action: "inspect" });
		expect(unchanged.streaming).toBe(true);
		expect(unchanged.instance).toBe(1);
		expect(unchanged.staleApiRejected).toBe(false);
		expect(unchanged.received).toEqual(received.received);
		expect(unchanged.localEvents).toBe(0);

		await left.request({ action: "dispose" });
		const completed = await right.request({ action: "release" });
		expect(completed.streaming).toBe(false);
		expect(completed.assistants.at(-1)).toBe("done:right");
		expect(completed.providerCalls).toBe(2);
		expect(completed.users).toEqual(["work:right"]);
		expect(completed.sessionId).toBe(right.initial.sessionId);
		expect(completed.extensionErrors).toEqual([]);
		expect(reloaded.extensionErrors).toEqual([]);
		expect(left.getStderr()).not.toContain("Event handler error");
		expect(right.getStderr()).not.toContain("Event handler error");
		await right.request({ action: "dispose" });
	});

	it("can run again and receive an event through a fresh extension after reload", async () => {
		const router = new AgentEventRouter();
		routers.push(router);
		const [left, right] = await Promise.all([startProbe("left", router), startProbe("right", router)]);
		await left.request({ action: "start" });
		const first = await left.request({ action: "release" });
		expect(first.assistants.at(-1)).toBe("done:left");
		await left.request({ action: "reload" });
		await expect(left.request({ action: "stale-send" })).rejects.toThrow("stale");
		const [restarted, sibling] = await Promise.all([
			left.request({ action: "start" }),
			right.request({ action: "start" }),
		]);
		expect([restarted.streaming, sibling.streaming]).toEqual([true, true]);
		expect(restarted.sessionId).toBe(left.initial.sessionId);
		expect(restarted.users).toEqual(["work:left", "work:left"]);
		expect(restarted.instance).toBe(2);

		await right.request({ action: "send", to: "left", text: "after reload" });
		const received = await left.request({ action: "inspect" });
		expect(received.received).toEqual([{ from: "right", text: "after reload" }]);
		expect(received.customEntries.filter((entry) => entry.customType === "test:received")).toHaveLength(1);
		expect(received.users).toEqual(["work:left", "work:left"]);
		const [leftDone, rightDone] = await Promise.all([
			left.request({ action: "release" }),
			right.request({ action: "release" }),
		]);
		expect(leftDone.assistants.filter((text) => text === "done:left")).toHaveLength(2);
		expect(rightDone.assistants.at(-1)).toBe("done:right");
		expect([leftDone.extensionErrors, rightDone.extensionErrors]).toEqual([[], []]);
		expect(left.getStderr()).not.toContain("Event handler error");
		expect(right.getStderr()).not.toContain("Event handler error");
		await Promise.all([left.request({ action: "dispose" }), right.request({ action: "dispose" })]);
	});

	it("rejects unknown and disposed recipients without completing or disturbing the sender", async () => {
		const router = new AgentEventRouter();
		routers.push(router);
		const [left, right] = await Promise.all([startProbe("left", router), startProbe("right", router)]);
		await left.request({ action: "start" });
		await expect(left.request({ action: "send", to: "missing", text: "not delivered" })).rejects.toThrow(
			"not connected",
		);
		await right.request({ action: "dispose" });
		await expect(left.request({ action: "send", to: "right", text: "not delivered" })).rejects.toThrow(
			"not connected",
		);
		const running = await left.request({ action: "inspect" });
		expect(running.streaming).toBe(true);
		expect(running.users).toEqual(["work:left"]);
		expect(running.customEntries.filter((entry) => entry.customType === "test:received")).toEqual([]);
		await left.request({ action: "dispose" });
	});

	it("lets an ordinary extension report completion without prompting or stopping its recipient", async () => {
		const router = new AgentEventRouter();
		routers.push(router);
		const [left, right] = await Promise.all([startProbe("left", router), startProbe("right", router)]);
		await left.request({ action: "report", to: "right" });
		await Promise.all([left.request({ action: "start" }), right.request({ action: "start" })]);
		await left.request({ action: "release" });
		await expect
			.poll(async () =>
				(await right.request({ action: "inspect" })).customEntries.filter(
					(entry) => entry.customType === "test:finished",
				),
			)
			.toEqual([{ customType: "test:finished", data: { sessionId: left.initial.sessionId } }]);
		const recipient = await right.request({ action: "inspect" });
		expect(recipient.streaming).toBe(true);
		expect(recipient.users).toEqual(["work:right"]);
		expect(recipient.providerCalls).toBe(1);
		const sender = await left.request({ action: "inspect" });
		expect(sender.customEntries.filter((entry) => entry.customType === "test:finished")).toEqual([]);
		await Promise.all([left.request({ action: "dispose" }), right.request({ action: "dispose" })]);
	});

	it("uses native extension errors and unsubscribes on session disposal without closing the process transport", async () => {
		const router = new AgentEventRouter();
		routers.push(router);
		const [left, right] = await Promise.all([startProbe("left", router), startProbe("right", router)]);
		await left.request({ action: "send", to: "right", text: "handler-error" });
		const failed = await right.request({ action: "inspect" });
		expect(failed.extensionErrors).toEqual(["deliberate agent event handler failure"]);
		expect(failed.users).toEqual([]);
		expect(failed.received).toEqual([]);
		await right.request({ action: "dispose-session" });
		await expect(left.request({ action: "send", to: "right", text: "after disposal" })).rejects.toThrow(
			"not listening",
		);
		expect((await right.request({ action: "inspect" })).pid).toBe(right.initial.pid);
		await left.request({ action: "dispose" });
	});
});
