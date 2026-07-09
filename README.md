# Akua CLI

Greenfield Akua Cloud CLI prototype.

The canonical binary is `akua`. This repository is intentionally moving away
from the old CNAP-era Go CLI; no `cnap` binary or
`github.com/cnap-tech/cli` compatibility is required for the first Akua
release.

## Current Status

This scaffold establishes the architecture, packaging path, OpenAPI fetch task,
public operation registry generation, release automation, output/error runtime
contract, and local auth/config token handling. It does not yet implement full
API command execution.

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
mise run build                  # typecheck and build JS into dist/js/
mise run build:binary           # compile self-contained dist/akua
mise run test                   # run Bun tests
mise run spec:fetch             # fetch https://api.akua.dev/v1/openapi.json
mise run generate               # regenerate public command registry
mise run generate:check         # verify generated registry is current
```

Implemented commands:

```sh
akua                                      # show compact registry status
akua auth login --token <token>           # save a local API token
akua auth status                          # show effective auth source
akua auth logout                          # remove the saved local API token
akua commands                            # list first 20 generated public commands
akua commands --resource workspaces      # filter by generated resource
akua commands --operation-id workspaces.list
akua commands --limit 5
akua --help                              # also -h
akua --version                           # also -v or -V
```

## Authentication

`AKUA_API_TOKEN` is the primary noninteractive credential and takes precedence
over any stored token. `akua auth login --token <token>` writes the token to
`~/.config/akua/config.json`, preserving unrelated config keys and setting the
Akua config directory to `0700` and file to `0600`. `akua auth logout` removes
only the stored token; it does not clear `AKUA_API_TOKEN`. Browser/device login
is not implemented in this MVP slice.

## OpenAPI Source

The live production source of truth is:

```text
https://api.akua.dev/v1/openapi.json
```

`mise run spec:fetch` writes the fetched snapshot to `openapi/public.json`.
`mise run generate` reads that snapshot and writes
`src/generated/commands.gen.ts`.
The fetcher defaults to `AKUA_OPENAPI_URL` when set and rejects non-HTTPS
override URLs.

The scheduled `Update OpenAPI` workflow is idempotent: after fetching and
generating, it opens a pull request only when `openapi/public.json` or
`src/generated/commands.gen.ts` changed. The workflow fails if the update touches
any other tracked or untracked files.

## Release Automation

Release Please runs in manifest mode from `release-please-config.json` and
`.release-please-manifest.json`. It prepares release pull requests for the root
Bun package, updates package metadata, `CHANGELOG.md`, and the `akua --version`
marker in `src/bin/akua.ts`, and creates `v*` version tags and GitHub releases
after release PRs merge.

The workflow uses `secrets.RELEASE_PLEASE_TOKEN` so release-created tags can
trigger the tag-based release workflow.

The separate tag-triggered release workflow builds and uploads the Linux x64
binary artifact. The Release Please config does not add npm publishing or expand
binary publishing behavior.

## Runtime Contract

Default output is adaptive:

- coding-agent, CI, non-TTY, and automation signals use compact structured
  agent output;
- interactive TTY sessions use human output;
- `--json`, `--quiet`, `-q`, `--output <mode>`, `-o <mode>`, and `AKUA_OUTPUT`
  override detection.

Supported output modes are `human`, `agent`, `json`, and `quiet`.

See [docs/architecture.md](docs/architecture.md) for the full CLI spec.
