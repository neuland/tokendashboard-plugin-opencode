# ADR-001: opencode Plugin event Hook over MCP Server

## Decision
Capture token usage via opencode's plugin system and its `event` hook (`message.updated`, `session.idle`, `session.created`, …), not an MCP server. 
opencode loads plugins in-process and dispatches these lifecycle events automatically; assistant messages carry token counts and a precomputed cost directly.

## Why
- The hook fires automatically with no model decision involved — fully passive, gap-free tracking.
- An MCP server requires the model to actively call a tool to log usage; that leaves tracking incomplete whenever the model doesn't call it.
- The plugin runs in-process for the opencode process lifetime, so in-memory state (e.g. the dedupe set) persists across events within a run.

## Alternatives considered
- **MCP server:** flexible and queryable, but requires explicit tool calls — no automatic, gap-free tracking.
- **Polling `client.session.messages(...)`:** works for on-demand queries, but the `event` hook is simpler and gap-free for passive capture — no need to track which messages were already seen across polls.
