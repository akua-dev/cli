---
name: agent-skills-standard-following
description: Use Akua safely and predictably from a coding agent. Apply when inspecting an Akua workspace, discovering CLI operations, configuring Akua MCP servers, authenticating the Akua CLI, or planning resource changes that require user approval.
---

# Use Akua from an agent

## Establish available tools

Prefer current documentation and live workspace context over guessed commands:

1. Use the Akua docs MCP at `https://docs.akua.dev/mcp` for current product and API guidance.
2. Use the authenticated platform MCP at `https://mcp.akua.dev` for live workspace context and supported actions.
3. If the CLI is installed, run:

   ```sh
   akua --version
   akua --help
   akua commands --limit 5
   ```

Treat `akua --help` as the executable command contract. `akua commands` lists
operationId-derived public registry entries; listing an operation does not prove
that this CLI version executes it.

## Authenticate without leaking credentials

Prefer `AKUA_API_TOKEN` for ephemeral agent and CI sessions. Use `akua auth
status` to inspect only the credential source. Never print, commit, log, or echo
the token.

Use `akua auth login --token ...` only when the user asks for persisted local
authentication. It stores a token in `~/.config/akua/config.json`. Use `akua
auth logout` to remove only that stored token; it cannot clear an inherited
`AKUA_API_TOKEN`.

## Keep output deterministic

Set `AGENT=<name>` when the environment does not already identify the agent.
Prefer `--json` for programmatic parsing and default agent output for concise
observations and next steps. Do not parse human tables when structured output is
available.

Fail on unknown commands or flags. Do not invent a command from an OpenAPI
operationId; confirm it with `akua --help` and the registry first.

## Apply safety gates

Read-only discovery and status checks are safe defaults. Obtain explicit user approval
immediately before creating, updating, deleting, deploying, or spending
through Akua. Show the exact intended resource, scope, and command before the
approval gate. Never bypass a confirmation or concurrency/idempotency guard.

After an approved action, verify the returned operation or resource state and
report concrete identifiers. If the installed CLI does not execute the required
operation, use a supported MCP action or stop with the missing capability; do
not improvise a private API call.
