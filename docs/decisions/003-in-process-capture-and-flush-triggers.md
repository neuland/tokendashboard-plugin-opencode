# ADR-003: In-Process Capture with Flush on Init, Idle and Dispose

## Decision
opencode loads the plugin in-process — the factory runs once per process and its hooks live for the process lifetime; there is no host-invoked command hook. Capture and flush are therefore both driven from the `event` hook, the factory body, and `dispose`:

- **Capture** on `message.updated`: when an assistant message finalizes, write one queue entry (see ADR-009).
- **Flush** the queue to the endpoint on three triggers: factory load (drains any queue a previous crashed/offline run left behind), `session.idle` (debounced so a burst of idle events produces one POST), and `dispose` (best-effort final flush on clean teardown).

Capture is synchronous; flush is asynchronous and fire-and-forget.

## Why
- opencode dispatches the `event` hook fire-and-forget — it does not await the plugin's async work. A deferred async write could be cut off when the process exits, so capture writes synchronously and atomically (`writeEntry`, see ADR-004).
- Queue entries are deleted only on a genuine 2xx (see ADR-005), so a flush cut off by process exit loses nothing — entries stay queued and the next start's init flush sends them. Flush therefore doesn't need capture's synchronous guarantee.
- `dispose` alone is insufficient: it is best-effort and never runs on SIGKILL, and it can't drain a queue left by a previous crashed run — the init flush is the backstop that makes the system self-healing across restarts.
- A message the user aborts mid-generation is captured only if opencode still sets `time.completed` on it; otherwise that turn's tokens are lost, same as a SIGKILL before finalization (consistent with the finality rule in ADR-009).

## Alternatives considered
- **Flush on every `message.updated`:** far too frequent, especially costly when the endpoint is unreachable (a 5s timeout per attempt).
- **Rely solely on `dispose`:** doesn't run on SIGKILL and can't drain a crashed run's leftover queue.
