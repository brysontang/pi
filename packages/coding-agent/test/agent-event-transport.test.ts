import { once } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentEventTransport, createAgentEventTransportPeer } from "../src/core/agent-event-transport.ts";
import { type AgentEvent, AgentEventRouter } from "../src/core/agent-events.ts";

const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.useRealTimers();
});

// Test-only adapter over actual message ports. Pi, not the adapter, owns the event protocol.
function portTransport(port: MessagePort): AgentEventTransport {
	let closed = false;
	port.once("close", () => {
		closed = true;
	});
	return {
		async send(message) {
			if (closed) throw new Error("Message port is closed");
			port.postMessage(message);
		},
		onMessage(handler) {
			port.on("message", handler);
			return () => {
				port.off("message", handler);
			};
		},
		onClose(handler) {
			port.on("close", handler);
			if (closed) handler();
			return () => {
				port.off("close", handler);
			};
		},
	};
}

function createPair() {
	const { port1, port2 } = new MessageChannel();
	cleanups.push(() => {
		port1.close();
		port2.close();
	});
	const hostTransport = portTransport(port1);
	const workerTransport = portTransport(port2);
	const host = createAgentEventTransportPeer(hostTransport);
	const worker = createAgentEventTransportPeer(workerTransport);
	const router = new AgentEventRouter();
	const parent = router.connect("parent");
	host.onClose(router.attach("worker", host.connection));
	cleanups.push(() => {
		router.close();
		host.close();
		worker.close();
	});
	return { port1, port2, hostTransport, workerTransport, host, worker, router, parent };
}

describe("native event protocol over a supplied transport", () => {
	it("uses host-bound identities and snapshots payloads in both directions without broadcasting", async () => {
		const { parent, worker, router } = createPair();
		const received: AgentEvent[] = [];
		const replies: AgentEvent[] = [];
		const unrelated = vi.fn();
		router.connect("unrelated").onEvent(unrelated);
		parent.onEvent((event) => received.push(event));
		worker.channel.onEvent((event) => replies.push(event));
		const data = { from: "forged", nested: { count: 1 } };
		const sending = worker.channel.send("parent", "test:note", data);
		data.nested.count = 2;
		await sending;
		expect(received).toEqual([
			{
				type: "agent_event",
				from: "worker",
				to: "parent",
				customType: "test:note",
				data: { from: "forged", nested: { count: 1 } },
			},
		]);
		await parent.send("worker", "test:reply", { accepted: true });
		expect(replies).toEqual([
			{ type: "agent_event", from: "parent", to: "worker", customType: "test:reply", data: { accepted: true } },
		]);
		expect(unrelated).not.toHaveBeenCalled();
	});

	it("rejects unknown recipients and missing listeners without saving events for a later listener", async () => {
		const { parent, worker } = createPair();
		await expect(worker.channel.send("missing", "test:note")).rejects.toThrow("not connected");
		await expect(parent.send("worker", "test:lost")).rejects.toThrow("not listening");
		const received = vi.fn();
		const off = worker.channel.onEvent(received);
		await parent.send("worker", "test:current");
		expect(received).toHaveBeenCalledExactlyOnceWith({
			type: "agent_event",
			from: "parent",
			to: "worker",
			customType: "test:current",
		});
		off();
		await expect(parent.send("worker", "test:lost-again")).rejects.toThrow("not listening");
	});

	it("copies delivery for each listener", async () => {
		const { parent, worker } = createPair();
		worker.channel.onEvent((event) => {
			event.customType = "test:mutated";
		});
		const received = vi.fn();
		worker.channel.onEvent(received);
		await parent.send("worker", "test:original");
		expect(received).toHaveBeenCalledWith({
			type: "agent_event",
			from: "parent",
			to: "worker",
			customType: "test:original",
		});
	});

	it("rejects non-JSON data before submitting it to the transport", async () => {
		const { worker, workerTransport } = createPair();
		const send = vi.spyOn(workerTransport, "send");
		for (const data of [1n, new Map(), { missing: undefined }, NaN]) {
			await expect(worker.channel.send("parent", "test:note", data)).rejects.toThrow("JSON value");
		}
		expect(send).not.toHaveBeenCalled();
	});

	it("rejects a failed write once and releases its acceptance timer without substituting a transport", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { worker, workerTransport } = createPair();
		const send = vi.spyOn(workerTransport, "send").mockRejectedValue(new Error("write failed"));
		await expect(worker.channel.send("parent", "test:note")).rejects.toThrow("write failed");
		expect(send).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("closes both peers and detaches the route without owning the underlying ports", async () => {
		const { host, worker, parent, port1, port2 } = createPair();
		const remoteClosed = new Promise<void>((resolve) => host.onClose(resolve));
		worker.close();
		await remoteClosed;
		await expect(parent.send("worker", "test:note")).rejects.toThrow("not connected");
		await expect(worker.channel.send("parent", "test:note")).rejects.toThrow("closed");
		expect(port1.listenerCount("message")).toBe(0);
		expect(port2.listenerCount("message")).toBe(0);
		// The owner's unrelated message stream is still alive after the event peer closes.
		const otherMessage = once(port1, "message");
		port2.postMessage({ owner: "still running" });
		expect(await otherMessage).toEqual([{ owner: "still running" }]);
	});

	it("rejects pending delivery on physical disconnect and clears subscriptions and timers", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { host, worker, workerTransport, port1, port2, parent } = createPair();
		worker.channel.onEvent(() => {});
		// Drop only the acceptance reply, then physically disconnect the live port.
		vi.spyOn(workerTransport, "send").mockResolvedValue(undefined);
		const sent = once(port2, "message");
		const pending = expect(parent.send("worker", "test:note")).rejects.toThrow("closed");
		await sent;
		const disconnected = new Promise<void>((resolve) => host.onClose(resolve));
		port1.close();
		await disconnected;
		await pending;
		expect(port1.listenerCount("message")).toBe(0);
		expect(port1.listenerCount("close")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("times out missing acceptance without retries", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { worker, workerTransport } = createPair();
		const send = vi.spyOn(workerTransport, "send").mockResolvedValue();
		const pending = expect(worker.channel.send("parent", "test:note")).rejects.toThrow("acceptance timed out");
		await vi.advanceTimersByTimeAsync(30_000);
		await pending;
		expect(send).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["close subscription", "message subscription"])("cleans up if closure occurs during %s", async (during) => {
		const offClose = vi.fn();
		const offMessage = vi.fn();
		let close = () => {};
		const transport: AgentEventTransport = {
			send: vi.fn().mockResolvedValue(undefined),
			onClose(handler) {
				close = handler;
				if (during === "close subscription") handler();
				return offClose;
			},
			onMessage: vi.fn(() => {
				close();
				return offMessage;
			}),
		};
		const peer = createAgentEventTransportPeer(transport);
		expect(offClose).toHaveBeenCalledTimes(1);
		expect(offMessage).toHaveBeenCalledTimes(during === "message subscription" ? 1 : 0);
		expect(transport.onMessage).toHaveBeenCalledTimes(during === "message subscription" ? 1 : 0);
		await expect(peer.channel.send("parent", "test:note")).rejects.toThrow("closed");
		expect(transport.send).not.toHaveBeenCalled();
		const closed = vi.fn();
		peer.onClose(closed);
		expect(closed).toHaveBeenCalledTimes(1);
	});

	it("releases the close subscription if message subscription fails", () => {
		const offClose = vi.fn();
		expect(() =>
			createAgentEventTransportPeer({
				send: async () => {},
				onClose: () => offClose,
				onMessage: () => {
					throw new Error("subscribe failed");
				},
			}),
		).toThrow("subscribe failed");
		expect(offClose).toHaveBeenCalledTimes(1);
	});
});
