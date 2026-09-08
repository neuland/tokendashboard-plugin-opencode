# ADR-006: User Pseudonymization via Random UUID

## Decision
On first run, generate a random UUID (`crypto.randomUUID()`) and persist it to `~/.config/opencode/tokendashboard-plugin/user-id`. Every payload carries this UUID as `user_id`; no other identifying information is sent. The UUID is read once per flush and reused for the lifetime of the file.

## Why
- Token costs need per-user attribution, but the plugin must not transmit personal data (names, emails, machine identifiers).
- opencode's session IDs are already sent per entry for de-duplication, but they're per-session, not per-user — they don't give stable cross-session attribution. A dedicated persistent UUID is the stable per-user key.

## Alternatives considered
- **OS username / email / hostname:** directly identifying — exactly what needs to be avoided.
- **No identifier at all:** loses per-user attribution, a core requirement for cost reporting.
