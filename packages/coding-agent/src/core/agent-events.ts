/** An explicitly addressed event. It is not a model message or a persisted session entry. */
export interface AgentEvent<T = unknown> {
	type: "agent_event";
	/** Assigned by the host's connection, never by the sending extension. */
	from: string;
	to: string;
	customType: string;
	data?: T;
}

export interface AgentEventChannel {
	/** Resolves on delivery acceptance, not handler completion. No replay or durable delivery is implied. */
	send(to: string, customType: string, data?: unknown): Promise<void>;
	/** The owner must unsubscribe when its session runtime is replaced or disposed. */
	onEvent(handler: (event: AgentEvent) => void): () => void;
}

/** Host side of a connection. A transport must reject delivery when its peer is unavailable. */
export interface AgentEventConnection {
	onSend(handler: AgentEventChannel["send"]): () => void;
	deliver(event: AgentEvent): Promise<void>;
}

export interface LocalAgentEventChannel extends AgentEventChannel {
	close(): void;
}

/** Copy at the boundary, with the same JSON value semantics for local and remote delivery. */
export function copyAgentEvent(event: AgentEvent): AgentEvent {
	if (!event.from || !event.to || !event.customType)
		throw new Error("Agent event addresses and customType must not be empty");
	const ancestors = new Set<object>();
	const check = (value: unknown): void => {
		if (value === null || typeof value === "string" || typeof value === "boolean") return;
		if (typeof value === "number" && Number.isFinite(value)) return;
		if (typeof value !== "object" || ancestors.has(value)) throw new Error("Agent event data must be a JSON value");
		const prototype = Object.getPrototypeOf(value);
		if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
			throw new Error("Agent event data must be a JSON value");
		}
		ancestors.add(value);
		for (const child of Array.isArray(value) ? value : Object.values(value)) check(child);
		ancestors.delete(value);
	};
	if (event.data !== undefined) check(event.data);
	return JSON.parse(JSON.stringify(event)) as AgentEvent;
}

/**
 * Routes only explicit agent events. It neither launches agents nor connects their local event buses.
 * Hosts attach their existing processes/transports; connection identity is authoritative within this router.
 */
export class AgentEventRouter {
	private connections = new Map<string, AgentEventConnection>();
	private detachments = new Set<() => void>();
	private closed = false;

	attach(id: string, connection: AgentEventConnection): () => void {
		if (this.closed) throw new Error("Agent event router is closed");
		if (!id || this.connections.has(id)) throw new Error(`Agent event address is empty or already connected: ${id}`);
		this.connections.set(id, connection);
		let attached = true;
		let unsubscribe: () => void;
		try {
			unsubscribe = connection.onSend(async (to, customType, data) => {
				if (!attached) throw new Error(`Agent event sender is disconnected: ${id}`);
				const target = this.connections.get(to);
				if (!target) throw new Error(`Agent event recipient is not connected: ${to}`);
				await target.deliver(copyAgentEvent({ type: "agent_event", from: id, to, customType, data }));
			});
		} catch (error) {
			this.connections.delete(id);
			throw error;
		}
		const detach = () => {
			if (!attached) return;
			attached = false;
			this.connections.delete(id);
			this.detachments.delete(detach);
			unsubscribe();
		};
		this.detachments.add(detach);
		return detach;
	}

	/** A local endpoint for an ordinary session in the host process. */
	connect(id: string): LocalAgentEventChannel {
		const handlers = new Set<(event: AgentEvent) => void>();
		let send: AgentEventChannel["send"] | undefined;
		const detach = this.attach(id, {
			onSend(handler) {
				send = handler;
				return () => {
					send = undefined;
					handlers.clear();
				};
			},
			async deliver(event) {
				if (!send || handlers.size === 0) throw new Error(`Agent event recipient is not listening: ${id}`);
				for (const handler of handlers) handler(copyAgentEvent(event));
			},
		});
		return {
			async send(to, customType, data) {
				if (!send) throw new Error(`Agent event sender is disconnected: ${id}`);
				await send(to, customType, data);
			},
			onEvent(handler) {
				if (!send) throw new Error(`Agent event endpoint is disconnected: ${id}`);
				handlers.add(handler);
				return () => {
					handlers.delete(handler);
				};
			},
			close: detach,
		};
	}

	close(): void {
		this.closed = true;
		for (const detach of this.detachments) detach();
	}
}
