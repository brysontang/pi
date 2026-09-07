import { describe, expect, it } from "vitest";
import { type AgentEvent, type AgentEventChannel, AgentEventRouter } from "../src/core/agent-events.ts";

describe("addressed agent events", () => {
	it("lets connected recipients exchange events while both resolutions are still starting", async () => {
		const received: AgentEvent[] = [];
		const opening: string[] = [];
		let bothConnected!: () => void;
		const connected = new Promise<void>((resolve) => {
			bothConnected = resolve;
		});
		const router = new AgentEventRouter({
			async resolveRecipient(address, signal) {
				const channel = router.connect(address);
				channel.onEvent((event) => received.push(event));
				opening.push(address);
				if (opening.length === 2) bothConnected();
				await connected;
				await Promise.race([
					channel.send(address === "b" ? "c" : "b", "example:starting"),
					new Promise<never>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					}),
				]);
			},
		});
		const sender = router.connect("a");
		const pending = Promise.all([sender.send("b", "example:message"), sender.send("c", "example:message")]);
		// Close explicitly on assertion failure too: the regression must not leave
		// unresolved host startup operations behind when demonstrating the deadlock.
		const settled = pending.then(
			() => true,
			() => false,
		);
		try {
			await expect
				.poll(() => received.filter((event) => event.customType === "example:message").length, { timeout: 500 })
				.toBe(2);
			await pending;
			expect(
				received.filter((event) => event.customType === "example:starting").map((event) => [event.from, event.to]),
			).toEqual([
				["b", "c"],
				["c", "b"],
			]);
			expect(opening).toEqual(["b", "c"]);
		} finally {
			router.close();
			await settled;
		}
	});

	it("waits for an opening local recipient that has connected but not bound its listener", async () => {
		let bind!: () => void;
		const binding = new Promise<void>((resolve) => {
			bind = resolve;
		});
		let connected!: () => void;
		const connecting = new Promise<void>((resolve) => {
			connected = resolve;
		});
		const received: AgentEvent[] = [];
		let opened = 0;
		const router = new AgentEventRouter({
			async resolveRecipient(address) {
				opened++;
				const channel = router.connect(address);
				connected();
				await binding;
				channel.onEvent((event) => received.push(event));
			},
		});
		const sender = router.connect("a");
		const first = sender.send("b", "example:message", 1);
		await connecting;
		const second = sender.send("b", "example:message", 2);
		bind();
		await Promise.all([first, second]);
		expect(opened).toBe(1);
		expect(received.map((event) => event.data)).toEqual([1, 2]);
		router.close();
	});

	it("resolves a dormant address once for concurrent sends and preserves each event snapshot", async () => {
		let ready!: () => void;
		const gate = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const received: AgentEvent[] = [];
		let opened = 0;
		const router = new AgentEventRouter({
			async resolveRecipient(address) {
				opened++;
				await gate;
				router.connect(address).onEvent((event) => received.push(event));
			},
		});
		const sender = router.connect("a");
		const data = { count: 1 };
		const sends = [sender.send("b", "example:message", data), sender.send("b", "example:message", { count: 2 })];
		data.count = 99;
		await Promise.resolve();
		expect(opened).toBe(1);
		ready();
		await Promise.all(sends);
		expect(received.map((event) => event.data)).toEqual([{ count: 1 }, { count: 2 }]);
		await sender.send("b", "example:message", { count: 3 });
		expect(opened).toBe(1);
		router.close();
	});

	it("checks permission before waking and on every send to a live recipient", async () => {
		let permitted = false;
		let opened = 0;
		let checked = 0;
		const received: AgentEvent[] = [];
		const router = new AgentEventRouter({
			authorize(event) {
				checked++;
				expect(event.from).toBe("a");
				if (!permitted) throw new Error("not permitted");
				event.from = "changed by admission";
				event.data = "changed by admission";
			},
			async resolveRecipient(address) {
				opened++;
				router.connect(address).onEvent((event) => received.push(event));
			},
		});
		const sender = router.connect("a");
		await expect(sender.send("b", "example:message", "original")).rejects.toThrow("not permitted");
		expect(opened).toBe(0);
		permitted = true;
		await sender.send("b", "example:message", "original");
		expect(received).toEqual([
			{ type: "agent_event", from: "a", to: "b", customType: "example:message", data: "original" },
		]);
		permitted = false;
		await expect(sender.send("b", "example:message", "refused")).rejects.toThrow("not permitted");
		expect(checked).toBe(4);
		expect(opened).toBe(1);
		expect(received).toHaveLength(1);
		router.close();
	});

	it("does not reuse an authorization decision between senders sharing one wake", async () => {
		let ready!: () => void;
		const gate = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const received: AgentEvent[] = [];
		let opened = 0;
		const router = new AgentEventRouter({
			authorize(event) {
				if (event.from !== "a") throw new Error("not permitted");
			},
			async resolveRecipient(address) {
				opened++;
				await gate;
				router.connect(address).onEvent((event) => received.push(event));
			},
		});
		const a = router.connect("a");
		const c = router.connect("c");
		const sending = a.send("b", "example:message");
		await expect(c.send("b", "example:message")).rejects.toThrow("not permitted");
		ready();
		await sending;
		expect(opened).toBe(1);
		expect(received.map((event) => event.from)).toEqual(["a"]);
		router.close();
	});

	it.each([false, true])(
		"rechecks each sender after a shared wake (connected while starting: %s)",
		async (connectEarly) => {
			let ready!: () => void;
			const gate = new Promise<void>((resolve) => {
				ready = resolve;
			});
			let started!: () => void;
			const opening = new Promise<void>((resolve) => {
				started = resolve;
			});
			const received: AgentEvent[] = [];
			const permitted = new Set(["a", "c"]);
			const checked: string[] = [];
			let opened = 0;
			const router = new AgentEventRouter({
				authorize(event) {
					checked.push(event.from);
					if (!permitted.has(event.from)) throw new Error("permission revoked");
				},
				async resolveRecipient(address) {
					opened++;
					const endpoint = connectEarly ? router.connect(address) : undefined;
					started();
					await gate;
					(endpoint ?? router.connect(address)).onEvent((event) => received.push(event));
				},
			});
			const a = router.connect("a");
			const c = router.connect("c");
			const first = a.send("b", "example:message", "revoked during wake");
			const result = expect(first).rejects.toThrow("permission revoked");
			await opening;
			const second = c.send("b", "example:message", "still permitted");
			// Let both sends pass initial admission and wait on the same startup.
			await expect.poll(() => checked.length).toBe(2);
			permitted.delete("a");
			ready();
			try {
				await Promise.all([result, second]);
				expect(opened).toBe(1);
				expect(checked).toEqual(["a", "c", "a", "c"]);
				expect(received).toEqual([
					{ type: "agent_event", from: "c", to: "b", customType: "example:message", data: "still permitted" },
				]);
			} finally {
				router.close();
			}
		},
	);

	it("does not wake for a sender detached while admission is pending", async () => {
		let admit!: () => void;
		const admission = new Promise<void>((resolve) => {
			admit = resolve;
		});
		let opened = 0;
		const router = new AgentEventRouter({
			authorize: () => admission,
			resolveRecipient: async () => {
				opened++;
			},
		});
		const sender = router.connect("a");
		const result = expect(sender.send("b", "example:message")).rejects.toThrow("sender is disconnected");
		sender.close();
		admit();
		await result;
		expect(opened).toBe(0);
		router.close();
	});

	it("does not deliver an old sender's pending event after its address is reused", async () => {
		let ready!: () => void;
		const gate = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const received: AgentEvent[] = [];
		const router = new AgentEventRouter({
			async resolveRecipient(address) {
				await gate;
				router.connect(address).onEvent((event) => received.push(event));
			},
		});
		const sender = router.connect("a");
		const result = expect(sender.send("b", "example:message", "old")).rejects.toThrow("sender is disconnected");
		sender.close();
		const replacement = router.connect("a");
		ready();
		await result;
		await replacement.send("b", "example:message", "new");
		expect(received.map((event) => event.data)).toEqual(["new"]);
		router.close();
	});

	it("aborts pending resolution when the scope closes and refuses late attachment", async () => {
		let started!: () => void;
		const starting = new Promise<void>((resolve) => {
			started = resolve;
		});
		const router = new AgentEventRouter({
			async resolveRecipient(_address, signal) {
				started();
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
		});
		const sender = router.connect("a");
		const result = expect(sender.send("b", "example:message")).rejects.toThrow(/aborted/i);
		await starting;
		router.close();
		await result;
		expect(() => router.connect("b")).toThrow("closed");
	});

	it("propagates wake failures without a retry and permits a later explicit send", async () => {
		let opened = 0;
		const received: AgentEvent[] = [];
		const router = new AgentEventRouter({
			async resolveRecipient(address) {
				opened++;
				if (opened === 1) throw new Error("launch failed");
				router.connect(address).onEvent((event) => received.push(event));
			},
		});
		const sender = router.connect("a");
		await expect(sender.send("b", "example:message", "failed")).rejects.toThrow("launch failed");
		expect(opened).toBe(1);
		await sender.send("b", "example:message", "explicit later send");
		expect(received.map((event) => event.data)).toEqual(["explicit later send"]);
		router.close();
	});

	it("requires the resolver to attach a recipient and never repairs a failed live delivery", async () => {
		let opened = 0;
		const router = new AgentEventRouter({
			resolveRecipient: async () => {
				opened++;
			},
		});
		const sender = router.connect("a");
		await expect(sender.send("b", "example:message")).rejects.toThrow("not connected");
		expect(opened).toBe(1);
		router.attach("b", {
			onSend: () => () => {},
			deliver: async () => {
				throw new Error("delivery failed");
			},
		});
		await expect(sender.send("b", "example:message")).rejects.toThrow("delivery failed");
		expect(opened).toBe(1);
		router.close();
	});

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
