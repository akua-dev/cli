# Akua CLI

Greenfield Akua Cloud CLI prototype.

The canonical binary is `akua`. This repository is intentionally moving away
from the old CNAP-era Go CLI; no `cnap` binary or
`github.com/cnap-tech/cli` compatibility is required for the first Akua
release.

## Current Status

This scaffold establishes the architecture, packaging path, OpenAPI fetch task,
public operation registry generation, and output/error runtime contract. It does
not yet implement full API command execution.

## Development

Prerequisites:

- [mise](https://mise.jdx.dev/)
- Bun, installed by `mise install`

```sh
mise install
bun install
mise run spec:fetch
mise run generate
mise run check
```

Useful tasks:

```sh
mise run dev -- --help          # run the TypeScript entrypoint
mise run build                  # typecheck and build JS into dist/
mise run build:binary           # compile self-contained dist/akua
mise run test                   # run Bun tests
mise run spec:fetch             # fetch https://api.akua.dev/v1/openapi.json
mise run generate               # regenerate public command registry
mise run generate:check         # verify generated registry is current
```

## OpenAPI Source

The live production source of truth is:

```text
https://api.akua.dev/v1/openapi.json
```

`mise run spec:fetch` writes the fetched snapshot to `openapi/public.json`.
`mise run generate` reads that snapshot and writes
`src/generated/commands.gen.ts`.

## Runtime Contract

Default output is adaptive:

- coding-agent, CI, non-TTY, and automation signals use compact structured
  agent output;
- interactive TTY sessions use human output;
- `--json`, `--quiet`, and `--output <mode>` override detection.

See [docs/architecture.md](docs/architecture.md) for the full CLI spec.
