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
its extension finishes work. Without a recipient resolver, unknown addresses and
disconnected peers reject delivery. Recipients without a bound runner also reject.
Acceptance is not persistence: process
failure can lose accepted events. There is no retry, replay, queue during reload,
automatic completion event, or implicit turn. Applications that need durable
delivery must provide it explicitly; they must not infer it from this channel.

## Host composition

### Shared scope and dormant participants

An address belongs to the routing scope, not to one runtime incarnation or one
request from another agent. A host can compose one router per shared conversation:

```ts
const router = new AgentEventRouter({
  authorize: checkCommunicationPermission,
  resolveRecipient: openParticipant,
});
```

`authorize(event)` runs on every send, before resolution or delivery, including
sends to a live recipient. After waiting for recipient resolution, it runs again
before delivery so revocation during startup takes effect. The callback must be
a repeatable permission check, not a one-shot grant or a launch operation.
Throw to refuse a send. Tau supplies the bound sender
and a copied event; it does not define permissions or let one sender's successful
admission authorize another sender's request.

`resolveRecipient(address, signal)` opens or restores the named participant and
attaches its ready connection through the same `connect` or `attach` methods used
below. Concurrent sends to one dormant address share one resolution. The callback
must finish when the recipient can accept events, not when its agent work ends.
Closing the router aborts pending resolution and prevents late attachments.
The host must clean up a partially started runtime if its setup fails.

A connected recipient can receive events while its resolver is still finishing.
For local channels, Pi's native extension binding installs the listener before
running `session_start` handlers. Those handlers can therefore send events to
other listening participants, including participants that are also starting,
without waiting for each other's entire startup. A concurrent send to a local
endpoint that has not bound its listener yet waits for its pending resolution.
For host-supplied connections, attach only when the peer can accept delivery.

For continuity, the resolver uses the same native `SessionManager` storage
reference for that address within this conversation. It can use Pi's
`AgentSessionRuntime` factory to restore an ordinary session, or the host's existing
remote launcher. Detach the connection when its runtime ends; a later send can
resolve it again. A only sends to B: it never carries B's storage reference, call
key, or previous result to get B's history back. Different routers can resolve
the same address into different conversations.

These hooks do not persist an inbox, introduce a broker, select a storage backend,
or make every event trigger inference. The receiving extension still decides
whether to append a native entry, steer, start a turn, reply, or do nothing.
Replies are ordinary addressed events; cycles do not create a parent/child call
stack. A live delivery failure is reported without restarting the recipient or
retrying the event. The next explicit send may attempt a failed resolution again.

### Connections

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
attaching peers or through the router's `authorize` callback. Tau supplies no
authorization policy. The host must supply any required authentication and
encryption before handing a transport to the peer. Neither the protocol nor the
Node IPC adapter adds encryption. A local child process is not a security sandbox.

Close the peer when its owning worker ends; this closes only the event channel.
It does not kill the process or dispose its session. The host owns those native
lifecycles. A turn finishing does not close its channel or stop any other agent.
Keep the channel across a reload, but do not reuse one endpoint for multiple
active sessions. Close the router when its owning group is disposed.
