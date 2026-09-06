import { type AgentEvent, type AgentEventChannel, type AgentEventConnection, copyAgentEvent } from "./agent-events.ts";

type Frame =
	| { type: "pi_agent_event"; op: "send"; id: string; to: string; customType: string; data?: unknown }
	| { type: "pi_agent_event"; op: "deliver"; id: string; event: AgentEvent }
	| { type: "pi_agent_event"; op: "result"; id: string; error?: string }
	| { type: "pi_agent_event"; op: "close" };

/** A live, ordered, bidirectional message transport. The host owns its security and lifecycle. */
export interface AgentEventTransport {
	/** Send one opaque protocol message. Reject when delivery to the transport fails; do not retry or replay. */
	send(message: object): Promise<void>;
	/** Subscribe to incoming messages. Return an unsubscribe function. */
	onMessage(handler: (message: unknown) => void): () => void;
	/** Subscribe to terminal closure or failure. Call immediately if already closed. */
	onClose(handler: () => void): () => void;
}

export interface AgentEventPeer {
	/** Inject into the ordinary session's resource loader on the agent side. */
	channel: AgentEventChannel;
	/** Attach to the router on the host side. The host assigns the sender address. */
	connection: AgentEventConnection;
	onClose(handler: () => void): () => void;
	/** Closes only this event channel, not the process or the native agent session. */
	close(): void;
}

/**
 * Pi's event protocol over a host-supplied message transport.
 * This is transport acceptance only: handlers, persistence and any reply event belong to extensions.
 */
export function createAgentEventTransportPeer(transport: AgentEventTransport): AgentEventPeer {
	let closed = false;
	let sequence = 0;
	let route: AgentEventChannel["send"] | undefined;
	let unsubscribeMessage = () => {};
	let unsubscribeClose = () => {};
	const listeners = new Set<(event: AgentEvent) => void>();
	const closeListeners = new Set<() => void>();
	const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();

	const write = async (frame: Frame): Promise<void> => {
		if (closed) throw new Error("Agent event transport is closed");
		await transport.send(frame);
	};
	const shutdown = () => {
		if (closed) return;
		closed = true;
		unsubscribeMessage();
		unsubscribeClose();
		for (const request of pending.values()) request.reject(new Error("Agent event transport is closed"));
		pending.clear();
		listeners.clear();
		route = undefined;
		for (const handler of closeListeners) handler();
		closeListeners.clear();
	};
	const request = (frame: Extract<Frame, { op: "send" | "deliver" }>): Promise<void> =>
		new Promise((resolve, reject) => {
			if (closed) {
				reject(new Error("Agent event transport is closed"));
				return;
			}
			const timer = setTimeout(() => {
				pending.delete(frame.id);
				reject(new Error("Agent event delivery acceptance timed out"));
			}, 30_000);
			pending.set(frame.id, {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			void write(frame).catch((error: unknown) => {
				pending.get(frame.id)?.reject(error instanceof Error ? error : new Error(String(error)));
				pending.delete(frame.id);
			});
		});
	const accept = async (frame: Record<string, unknown>): Promise<void> => {
		switch (frame.op) {
			case "send":
				if (typeof frame.to !== "string" || typeof frame.customType !== "string")
					throw new Error("Invalid agent event address or customType");
				if (!route) throw new Error("Agent event sender is not attached to a router");
				await route(frame.to, frame.customType, frame.data);
				return;
			case "deliver": {
				const event = frame.event;
				if (
					typeof event !== "object" ||
					event === null ||
					!("type" in event) ||
					event.type !== "agent_event" ||
					!("from" in event) ||
					typeof event.from !== "string" ||
					!("to" in event) ||
					typeof event.to !== "string" ||
					!("customType" in event) ||
					typeof event.customType !== "string"
				)
					throw new Error("Invalid agent event envelope");
				if (listeners.size === 0) throw new Error("Agent event recipient is not listening");
				const received = copyAgentEvent({
					type: "agent_event",
					from: event.from,
					to: event.to,
					customType: event.customType,
					data: "data" in event ? event.data : undefined,
				});
				for (const listener of listeners) listener(copyAgentEvent(received));
				return;
			}
			default:
				throw new Error("Invalid agent event operation");
		}
	};
	function receive(value: unknown): void {
		if (closed) return;
		if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "pi_agent_event") return;
		const frame = value as Record<string, unknown>;
		if (frame.op === "close") {
			shutdown();
			return;
		}
		if (typeof frame.id !== "string") {
			shutdown();
			return;
		}
		const id = frame.id;
		if (frame.op === "result") {
			const waiting = pending.get(id);
			pending.delete(id);
			if (frame.error === undefined) waiting?.resolve();
			else
				waiting?.reject(new Error(typeof frame.error === "string" ? frame.error : "Invalid agent event response"));
			return;
		}
		void accept(frame)
			.then(
				() => write({ type: "pi_agent_event", op: "result", id }),
				(error: unknown) =>
					write({
						type: "pi_agent_event",
						op: "result",
						id,
						error: error instanceof Error ? error.message : String(error),
					}),
			)
			.catch(shutdown);
	}
	const onClose = (handler: () => void) => {
		if (closed) {
			handler();
			return () => {};
		}
		closeListeners.add(handler);
		return () => {
			closeListeners.delete(handler);
		};
	};
	try {
		unsubscribeClose = transport.onClose(shutdown);
		if (closed) unsubscribeClose();
		else {
			unsubscribeMessage = transport.onMessage(receive);
			if (closed) unsubscribeMessage();
		}
	} catch (error) {
		shutdown();
		throw error;
	}
	return {
		channel: {
			async send(to, customType, data) {
				// Validate and snapshot before yielding, including on the sending side of the transport.
				const event = copyAgentEvent({ type: "agent_event", from: "sender", to, customType, data });
				await request({
					type: "pi_agent_event",
					op: "send",
					id: String(++sequence),
					to: event.to,
					customType: event.customType,
					data: event.data,
				});
			},
			onEvent(handler) {
				if (closed) throw new Error("Agent event transport is closed");
				listeners.add(handler);
				return () => {
					listeners.delete(handler);
				};
			},
		},
		connection: {
			onSend(handler) {
				if (closed) throw new Error("Agent event transport is closed");
				if (route) throw new Error("Agent event transport already has a router");
				route = handler;
				return () => {
					route = undefined;
				};
			},
			async deliver(event) {
				await request({
					type: "pi_agent_event",
					op: "deliver",
					id: String(++sequence),
					event: copyAgentEvent(event),
				});
			},
		},
		onClose,
		close() {
			if (closed) return;
			void write({ type: "pi_agent_event", op: "close" }).catch(() => {});
			shutdown();
		},
	};
}
