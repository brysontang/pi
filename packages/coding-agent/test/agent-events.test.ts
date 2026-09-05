import { describe, expect, it } from "vitest";
import { type AgentEvent, type AgentEventChannel, AgentEventRouter } from "../src/core/agent-events.ts";

describe("addressed agent events", () => {
	it("stamps the sender, snapshots JSON data, and does not broadcast", async () => {
		const router = new AgentEventRouter();
		const left = router.connect("left");
		const right = router.connect("right");
		const third = router.connect("third");
		const received: AgentEvent[] = [];
		const unrelated: AgentEvent[] = [];
		right.onEvent((event) => received.push(event));
		third.onEvent((event) => unrelated.push(event));
		const data = { from: "forged", nested: { count: 1 } };
		const sending = left.send("right", "test:note", data);
		data.nested.count = 2;
		await sending;
		expect(received).toEqual([
			{
				type: "agent_event",
				from: "left",
				to: "right",
				customType: "test:note",
				data: { from: "forged", nested: { count: 1 } },
			},
		]);
		expect(unrelated).toEqual([]);
		router.close();
	});

	it("rejects missing listeners, missing destinations and closed endpoints", async () => {
		const router = new AgentEventRouter();
		const left = router.connect("left");
		const right = router.connect("right");
		await expect(left.send("missing", "test:note")).rejects.toThrow("not connected");
		await expect(left.send("right", "test:note")).rejects.toThrow("not listening");
		const off = right.onEvent(() => {});
		await left.send("right", "test:note");
		off();
		await expect(left.send("right", "test:note")).rejects.toThrow("not listening");
		right.close();
		await expect(left.send("right", "test:note")).rejects.toThrow("not connected");
		router.close();
		await expect(left.send("left", "test:note")).rejects.toThrow("disconnected");
		expect(() => router.connect("new")).toThrow("closed");
	});

	it("rejects duplicate identity and does not revive a detached sender when the address is reused", async () => {
		const router = new AgentEventRouter();
		let send!: AgentEventChannel["send"];
		const detach = router.attach("left", {
			onSend: (handler) => {
				send = handler;
				return () => {};
			},
			deliver: async () => {},
		});
		expect(() => router.connect("left")).toThrow("already connected");
		detach();
		const replacement = router.connect("left");
		replacement.onEvent(() => {});
		await expect(send("left", "test:note")).rejects.toThrow("sender is disconnected");
		await replacement.send("left", "test:note");
		router.close();
	});

	it("returns delivery failure without retrying or substituting a transport", async () => {
		const router = new AgentEventRouter();
		const left = router.connect("left");
		let attempts = 0;
		router.attach("right", {
			onSend: () => () => {},
			deliver: async () => {
				attempts++;
				throw new Error("offline");
			},
		});
		await expect(left.send("right", "test:note")).rejects.toThrow("offline");
		expect(attempts).toBe(1);
		router.close();
	});

	it("does not wait for recipient work to finish", async () => {
		const router = new AgentEventRouter();
		const left = router.connect("left");
		const right = router.connect("right");
		let finish!: () => void;
		let finished = false;
		const work = new Promise<void>((resolve) => {
			finish = resolve;
		}).then(() => {
			finished = true;
		});
		right.onEvent(() => {
			void work;
		});
		await left.send("right", "test:note");
		expect(finished).toBe(false);
		finish();
		await work;
		router.close();
	});

	it("rejects non-JSON data instead of silently changing it at a process boundary", async () => {
		const router = new AgentEventRouter();
		const left = router.connect("left");
		const right = router.connect("right");
		right.onEvent(() => {
			throw new Error("must not deliver");
		});
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		for (const data of [
			NaN,
			Infinity,
			1n,
			() => {},
			new Map(),
			new Date(),
			{ value: undefined },
			[undefined],
			cyclic,
		]) {
			await expect(left.send("right", "test:note", data)).rejects.toThrow("JSON value");
		}
		router.close();
	});
});
