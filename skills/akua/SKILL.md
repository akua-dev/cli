---
name: akua
description: Guide agents working with Akua documentation, workspaces, authentication, generated CLI commands, structured output, and approval-safe operations. Use for Akua setup, inspection, troubleshooting, or change requests.
---

# Work with Akua

Use the most authoritative available surface for each kind of information. Keep discovery and reads separate from mutations, and report what actually happened.

## Choose the authoritative surface

1. Prefer the Akua docs MCP for current product and API documentation. Treat remembered documentation, copied examples, and model knowledge as potentially stale.
2. Use the Akua platform MCP and its Code Mode for authoritative workspace state. Read the relevant objects before drawing conclusions or proposing changes.
3. Use the canonical `akua` CLI when it is present and the needed behavior is released. Inspect the installed surface instead of assuming a command or install channel exists.

If an authoritative surface is unavailable, say which check could not be made. Do not substitute an inferred live state.

## Inspect the installed CLI

Start with read-only discovery:

```sh
command -v akua
akua --version
akua --help --output agent
akua auth status --output agent
akua commands --output agent
```

Use `akua commands --resource <resource>` or `akua commands --operation-id <operation_id>` to narrow the generated public command registry. Registry presence describes the generated surface; it does not prove that execution is implemented. If a command reports that it is not implemented, return to the docs or platform MCP instead of inventing flags or claiming success.

Never expose tokens from `AKUA_API_TOKEN` or the local config. `akua auth status` reports the effective source without revealing the credential. Treat `akua auth login --token <token>` and `akua auth logout` as local configuration mutations and run them only when explicitly requested.

## Select structured output deliberately

Akua supports `human`, `agent`, `json`, and `quiet` output modes.

- Set `AGENT=true` or `AGENT=<name>` to select agent-oriented output by default.
- Use `--output agent` for compact, self-describing AGENT output with observations, data, and next steps.
- Use `--json` or `--output json` when a program must parse the result.
- Use `--quiet` only when the exit status is sufficient.

Check the exit status and structured error payload before reporting success. Do not parse human prose when a structured mode is available.

## Preserve approvals and mutation boundaries

- Read current workspace state before planning a change. Use explicit workspace and resource identifiers.
- Do not create, update, delete, deploy, or resolve an approval request unless the human explicitly authorized that action.
- Preserve human approval gates. Do not add `--yes`, `--force`, confirmation responses, or approval resolutions merely to make automation continue.
- In agent, JSON, quiet, CI, or other non-interactive environments, never assume an interactive prompt will protect a mutation. Treat a confirmation-required or unsafe-mutation refusal as a stop condition.
- When a dry-run or preview is documented and available, inspect it before asking for mutation approval. Do not claim a preview changed live state.
- After an authorized mutation, read the authoritative state again and report identifiers, observed status, and any remaining approval or wait step.

Generated command discovery, desired configuration, and a submitted request are not evidence that live state changed. State clearly when execution is unavailable, refused, awaiting approval, or unverified.

## Avoid legacy and unavailable paths

Use only the `akua` executable. Do not suggest CNAP-era binaries, commands, module paths, domains, or compatibility aliases.

Do not claim that Akua is publicly installable through npm, Homebrew, `npx`, a skills marketplace, or another channel unless the current Akua docs MCP or a published release explicitly confirms it. If `akua` is not installed, report that fact and use the available MCP surfaces; do not invent installation instructions.
