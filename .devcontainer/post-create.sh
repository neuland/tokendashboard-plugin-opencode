#!/usr/bin/env bash
set -euo pipefail

# The claude-code devcontainer feature installs @anthropic-ai/claude-code as root into
# the global npm prefix, without restoring ownership to vscode like the node feature does
# for its other subdirectories (corepack/, npm/, pnpm/). That leaves Claude Code's own
# auto-updater — which runs as vscode — unable to write to its own package directory,
# failing with "no write permission to npm prefix" (~/.claude/.last-update-result.json
# shows status "no_permissions").
sudo chown -R vscode:nvm "$(npm config get prefix)/lib/node_modules"

# Bind-mounting host ~/.config/opencode and ~/.local/share/opencode creates the parent
# directories ~/.config/ and ~/.local/ owned by the host UID (macOS: 501). opencode needs
# to write to ~/.config/opencode/ and create ~/.local/state/, so fix the parent ownership
# and create the missing state directory before opencode starts.
for d in "$HOME/.config" "$HOME/.local"; do
  sudo mkdir -p "$d" 2>/dev/null || true
  sudo chown vscode:vscode "$d" 2>/dev/null || true
done
sudo mkdir -p "$HOME/.local/state" 2>/dev/null || true
sudo chown vscode:vscode "$HOME/.local/state" 2>/dev/null || true

# Seed ~/.claude.json once from the host's file (mounted read-only at a separate path,
# not bind-mounted onto ~/.claude.json itself) so Claude Code skips the theme/subscription
# prompts on every fresh container. A one-time copy, not a live sync: Claude Code writes
# this file via atomic rename (temp + rename), which detaches a single-file bind mount from
# the host inode, leaving the container with stale content until a rebuild. Copying once on
# creation avoids that without keeping host and container in sync afterwards.
if [ ! -f "$HOME/.claude.json" ] && [ -f /tmp/host-claude.json ]; then
  cp /tmp/host-claude.json "$HOME/.claude.json"
fi
