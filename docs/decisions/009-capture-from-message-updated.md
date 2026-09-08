# ADR-009: Capture from message.updated (Finality and Dedupe)

## Decision
opencode delivers assistant messages to the `event` hook as `message.updated` events, firing multiple times while a message streams and carrying the entire current message each time. Capture one queue entry per **finalized** assistant message:

- **Finality.** `time.completed` is set only on the final update; the plugin captures only when it is present.
- **Dedupe.** An in-memory `Set` of message ids (`seen`) ensures the repeated events for one message produce exactly one entry. It persists for the process lifetime, which is sufficient — a finished message is never re-streamed in a later process.
- **One entry per message.** Each assistant message has exactly one model, so no per-model split is needed within a message; a multi-step tool-call turn produces several finalized messages and therefore several entries, preserving per-model granularity automatically.
- **Idempotency key.** `entry_id = sha1(sessionID | messageID | modelID)` lets the backend defensively de-duplicate retransmissions.
- **Cost.** opencode's precomputed per-message `cost` (USD) is included as a cross-check; the backend stays authoritative for pricing.

Every assistant message — main agent or sub-agent step — arrives through this same stream already carrying its own model and finalized totals, so no separate subagent-transcript walk is needed.

## Why
- Waiting for `time.completed` avoids capturing non-authoritative in-flight token totals.
- The `message.updated` stream delivers each message exactly when it finalizes, so an in-memory dedupe set is simpler and gap-free compared to polling session state.
- Collapsing a whole turn into one entry would lose per-model granularity when a turn spans multiple models across tool-call steps.

## Alternatives considered
- **Capture on `session.idle` via the SDK client:** would require tracking which messages were already captured across idles.
