# Addressed agent events

An agent remains an ordinary `AgentSession`, with its own extensions, tools and
session manager. Hosts can connect those sessions without sharing their local
`pi.events` bus or adding messages to their conversations.

```ts
pi.on("agent_event", (event, ctx) => {
  if (event.customType !== "example:finished") return;
  // Optional: persist a native custom entry, steer, reply, or do nothing.
  pi.appendEntry(event.customType, event.data);
});

await pi.sendAgentEvent("reviewer", "example:finished", { artifact: "report.md" });
```

The event shape is `{ type: "agent_event", from, to, customType, data? }`.
`from` is assigned by the host's bound connection, not by the extension. Payloads
must be JSON values. Events are copied across both local and process boundaries.
Handler errors use the ordinary extension error path. Reload and disposal
unsubscribe the old runner; captured extension APIs become stale as usual.

`sendAgentEvent` resolves when the recipient channel accepts delivery, **not** when
its extension finishes work. Unknown addresses, disconnected peers, and recipients
without a bound runner reject delivery. Acceptance is not persistence: process
failure can lose accepted events. There is no retry, replay, queue during reload,
automatic completion event, or implicit turn. Applications that need durable
delivery must provide it explicitly; they must not infer it from this channel.

## Host composition

For a session in the host process, create an endpoint with
`router.connect(address)` and supply it as `agentEvents` to that session's
`DefaultResourceLoader`. Use a different loader and endpoint for every session.

For separate Node processes, use the host's existing launcher with an IPC fd:

```ts
const router = new AgentEventRouter();
const child = fork(workerPath, [], { cwd: workerDirectory });
const peer = createAgentEventPeer(child);
peer.onClose(router.attach("reviewer", peer.connection));
```

In the worker, `createAgentEventPeer().channel` supplies the `agentEvents` resource
loader option. The worker still constructs its session with `createAgentSession`
and its normal storage, tools, model and extensions. The channel does not launch
processes, duplicate RPC controls, own an agent loop, or select a persistence
backend. Stdout and the RPC stream are untouched.

For another message transport, use `createAgentEventTransportPeer(transport)` on
both sides. It runs the same protocol as the Node IPC adapter, including payload
validation, delivery acceptance, timeouts and disconnect handling. Implement only
`AgentEventTransport.send`, `onMessage` and `onClose`; do not duplicate the event
protocol. The transport must deliver ordered messages over a live bidirectional
connection, reject failed sends, and report terminal closure (including when a
close subscriber attaches after closure). It must not retry or replay messages.
The peer releases its subscriptions when closed; the host owns the underlying
transport's lifecycle.

For integrations that already provide their own protocol, `AgentEventConnection`
and `AgentEventChannel` remain the router-side and session-side interfaces.
Failed custom transports do not fall back to local delivery. The host must bind
addresses from its trusted connection metadata and enforce access policy before
attaching peers. A router connects all explicitly attached addresses; it is not
an authorization system. The host must supply any required authentication and
encryption before handing a transport to the peer. Neither the protocol nor the
Node IPC adapter adds encryption. A local child process is not a security sandbox.

Close the peer when its owning worker ends; this closes only the event channel.
It does not kill the process or dispose its session. The host owns those native
lifecycles. A turn finishing does not close its channel or stop any other agent.
Keep the channel across a reload, but do not reuse one endpoint for multiple
active sessions. Close the router when its owning group is disposed.
