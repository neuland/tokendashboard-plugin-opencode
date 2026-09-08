# ADR-004: Per-File Queue Directory and Concurrency

## Decision
Write one file per entry into `~/.config/opencode/tokendashboard-plugin/queue/`, named `${Date.now()}-${pid}-${counter}.json`. Each file is written atomically (`atomicWriteSync`: write to a PID-namespaced `.tmp`, then `fs.renameSync`). A single `queue/.lock` serializes flushes across processes via `acquireLock`/`releaseLock` (atomic `wx`, released in `finally`, with stale-lock stealing when the owning process is dead).

## Why
- Multiple opencode instances can share one queue directory and flush concurrently, so the queue must be safe under that concurrency without coordination beyond the flush lock.
- `pid` + a process-global `counter` keep filenames unique even when several entries are written in the same millisecond by the same process.
- The leading timestamp lets the flush prune entries older than `MAX_QUEUE_AGE_MS` (30 days), so a long endpoint outage can't grow the queue without bound.
- A concurrent flush snapshots the queue directory and deletes the whole snapshot on success. A plain `writeFileSync` would let a half-written file appear in that snapshot before its content is complete; `rename` publishes the final name only once the write is done, so the snapshot never sees a partial entry.

## Alternatives considered
- **Single append-only queue file:** concurrent appends from multiple processes interleave and corrupt entries.
- **SQLite / a database:** overkill for an append-and-drain queue, and adds a native dependency the plugin deliberately avoids.
