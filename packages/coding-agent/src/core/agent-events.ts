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

export interface AgentEventRouterOptions {
	/** Check before delivery and before waking a dormant recipient. Rechecked after wake; must be repeatable. */
	authorize?: (event: AgentEvent) => void | Promise<void>;
	/**
	 * Attach a ready recipient in this routing scope, restoring its existing session when appropriate.
	 * Concurrent sends to a dormant address share one resolution. This callback must not wait for
	 * the recipient's agent work to finish. Storage, launch policy and transport remain host-owned.
	 * The signal aborts when the routing scope closes; failed setup must release its own resources.
	 */
	resolveRecipient?: (address: string, signal: AbortSignal) => Promise<void>;
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
 * One addressed communication scope, independent of runtime lifetimes or spawning relationships.
 * Hosts attach existing processes/transports or resolve dormant recipients through their own factory.
 * Connection identity is authoritative. Event meaning, persistence and model turns belong to extensions.
 */
export class AgentEventRouter {
	private connections = new Map<string, AgentEventConnection>();
	private localListeners = new WeakMap<AgentEventConnection, Set<(event: AgentEvent) => void>>();
	private detachments = new Set<() => void>();
	private resolving = new Map<string, Promise<void>>();
	private resolutionAbort = new AbortController();
	private readonly options: AgentEventRouterOptions;
	private closed = false;

	constructor(options: AgentEventRouterOptions = {}) {
		this.options = options;
	}

	attach(id: string, connection: AgentEventConnection): () => void {
		if (this.closed) throw new Error("Agent event router is closed");
		if (!id || this.connections.has(id)) throw new Error(`Agent event address is empty or already connected: ${id}`);
		this.connections.set(id, connection);
		let attached = true;
		let unsubscribe: () => void;
		try {
			unsubscribe = connection.onSend(async (to, customType, data) => {
				if (!attached) throw new Error(`Agent event sender is disconnected: ${id}`);
				// Snapshot before an asynchronous admission or wake operation. Neither caller mutation nor
				// an admission callback may rewrite the sender or the event eventually delivered.
				const event = copyAgentEvent({ type: "agent_event", from: id, to, customType, data });
				if (this.options.authorize) await this.options.authorize(copyAgentEvent(event));
				if (!attached) throw new Error(`Agent event sender is disconnected: ${id}`);
				const connected = this.connections.get(to);
				// Native binding installs the listener before session_start handlers run.
				// Ready peers must be able to exchange events during those handlers:
				// waiting for each other's whole factory would create a startup cycle.
				if (!connected || (this.resolving.has(to) && this.localListeners.get(connected)?.size === 0)) {
					await this.resolveRecipient(to);
					if (!attached) throw new Error(`Agent event sender is disconnected: ${id}`);
					// Resolution may take arbitrarily long. Admission to wake a peer is
					// not a cached permission to deliver after the host's policy changes.
					if (this.options.authorize) await this.options.authorize(copyAgentEvent(event));
				}
				if (!attached) throw new Error(`Agent event sender is disconnected: ${id}`);
				const target = this.connections.get(to);
				if (!target) throw new Error(`Agent event recipient is not connected: ${to}`);
				await target.deliver(event);
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

	private async resolveRecipient(address: string): Promise<void> {
		const existing = this.resolving.get(address);
		if (existing) return existing;
		const resolve = this.options.resolveRecipient;
		if (!resolve) return;
		const pending = Promise.resolve().then(() => {
			this.resolutionAbort.signal.throwIfAborted();
			return resolve(address, this.resolutionAbort.signal);
		});
		this.resolving.set(address, pending);
		try {
			await pending;
		} finally {
			if (this.resolving.get(address) === pending) this.resolving.delete(address);
		}
	}

	/** A local endpoint for an ordinary session in the host process. */
	connect(id: string): LocalAgentEventChannel {
		const handlers = new Set<(event: AgentEvent) => void>();
		let send: AgentEventChannel["send"] | undefined;
		const connection: AgentEventConnection = {
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
		};
		this.localListeners.set(connection, handlers);
		const detach = this.attach(id, connection);
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
		this.resolutionAbort.abort();
		for (const detach of this.detachments) detach();
	}
}
