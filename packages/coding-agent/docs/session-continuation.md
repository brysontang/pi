# Continuing a session

`await session.continue()` resumes the selected native transcript without
adding a user prompt. It uses the same retries, compaction, message queues and
settled lifecycle as `prompt()`. Input expansion and `before_agent_start` do
not run because no new user input was submitted.

## Delayed tool results

A host may receive a tool's final outcome after the run that started it has
stopped, including after reopening the native session. Pass the existing
`ToolResultMessage` type to `continue()`:

```ts
await session.continue({
  role: "toolResult",
  toolCallId: originalResult.toolCallId,
  toolName: originalResult.toolName,
  content: [{ type: "text", text: "The external operation completed." }],
  details: completedResult,
  isError: false,
  timestamp: Date.now(),
});
```

The result must match a call with an existing result in the selected terminal
tool batch. Busy sessions, completed turns, unrelated calls and abandoned
branches refuse it. The host remains responsible for execution, authorization
and duplicate delivery; this API does not call or retry the tool.

Delivery emits native `message_start` and `message_end` events. It does not
emit another `tool_execution_start` or `tool_execution_end`: receiving an
outcome is not a second execution. Observers of completed result messages can
use `message_end` for both ordinary and delayed results.

All result entries remain in `getBranch()`/`getEntries()` for audit. Within one
assistant tool batch, context uses the latest result for each matching call.
`buildContextEntries()` and `buildSessionContext()` apply this same rule after
restart and compaction. A reused call ID in another assistant batch is a
different call. Delivery is persisted before model authentication and inference,
so a later inference failure does not discard the external outcome. Call
`continue()` without resupplying the result when retrying only the model turn.
