# ADR-005: Store-and-Forward HTTP with Batching and Dead-Lettering

## Decision
Forward queued entries over HTTP with store-and-forward semantics:

- **Batching.** Entries are sent in batches of `FLUSH_BATCH_SIZE` (500) so a long offline backlog never produces one oversized body the server rejects wholesale.
- **Genuine-success guard.** Entries are deleted only on a genuine ingest success (`isIngestSuccess`): a 2xx that was not redirected and does not carry an HTML body.
- **Retryable vs permanent.** Only a permanent 400/422 is treated as a content rejection; everything else (no response, 5xx, 408/429, 401/403/407, 404/405, a non-genuine 2xx) stays queued for the next flush.
- **Dead-letter with bisection.** A permanently-rejected batch is bisected and each half retried, so a single poison entry can't drag its blameless neighbours into quarantine; a lone entry the server still rejects is moved to `dead-letter/` (preserved for inspection, never retried).
- **Timeout across the body read.** `fetchWithTimeout` keeps the abort timer armed across the body read, not just the headers, so a stalled body trips the timeout instead of hanging.

## Why
- Off-network, a captive portal or auth proxy commonly answers a POST with its own 200 HTML page, or a 3xx redirect to one that `fetch` follows transparently. Treating either as success would delete data in exactly the offline scenario the queue exists for.
- Dead-lettering a whole rejected batch would quarantine up to 499 good entries alongside one bad one; bisection isolates the offender.
- Treating all 4xx as permanent would let a transient 4xx (a deploy blip, a misrouting gateway) silently dead-letter real data. The trade-off: a genuinely wrong `apiBaseUrl` keeps the queue growing rather than quarantining it — a deliberate bias toward not losing data.

## Alternatives considered
- **Delete on any 2xx:** loses data behind captive portals that answer 200-HTML.
