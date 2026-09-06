import type { ChildProcess } from "node:child_process";
import { type AgentEventPeer, createAgentEventTransportPeer } from "./agent-event-transport.ts";

/** Dedicated Node IPC adapter. Stdout and Pi's RPC stream are untouched. */
export function createAgentEventPeer(ipc: ChildProcess | NodeJS.Process = process): AgentEventPeer {
	if (!ipc.send || !ipc.connected) throw new Error("Agent event transport requires a connected IPC process");
	return createAgentEventTransportPeer({
		send: (message) =>
			new Promise((resolve, reject) => {
				if (!ipc.connected) {
					reject(new Error("Agent event transport is closed"));
					return;
				}
				ipc.send!(message, undefined, undefined, (error: Error | null) => {
					if (error) reject(error);
					else resolve();
				});
			}),
		onMessage(handler) {
			ipc.on("message", handler);
			return () => {
				ipc.off("message", handler);
			};
		},
		onClose(handler) {
			ipc.on("disconnect", handler);
			ipc.on("error", handler);
			if (!ipc.connected) handler();
			return () => {
				ipc.off("disconnect", handler);
				ipc.off("error", handler);
			};
		},
	});
}
