# Contributing to the Akua CLI

This file covers building, testing, and releasing this repository's source.
If you only want to use the `akua` executable, see [README.md](README.md)
instead.

**Canonical writable history is cnap.** This tree is prepared for the public Josh projection
of `tools/cli/source` (`viewId: cli`). Contribute via reviewed PRs on
`akua-dev/cnap`. Direct pushes to `akua-dev/cli` main are not the release path.
The SemVer for a public release is `tools/cli/source/package.json` `version`,
bumped in that cnap PR; the public `v<version>` tag is created later by the
outbound App at an admitted projected commit (not by release-please, not as a
cnap project tag).

## Prerequisites

[mise](https://mise.jdx.dev/) manages the pinned Bun toolchain:

```sh
mise install
bun install --frozen-lockfile
mise run check
mise run build:binary
./dist/akua --version
./dist/akua --help
./dist/akua commands --limit 1
```

`mise run check` runs the drift check, typecheck/build, and tests — the same
gate CI runs. Run it before opening a PR.

## Command generation

The command surface is generated from cnap's committed public OpenAPI document,
`docs/openapi-public.json` (produced in-graph by
`//packages/sdks/toolchain:generate_all` and drift-gated with the SDKs). There is
no weekly production fetch.

```sh
# From the cnap repository root:
bazel run //tools/cli:write_generated   # regenerate CLI .gen.ts from docs/openapi-public.json
bazel test //:sdk_generated_drift_test  # fail if committed generated output has drifted
# Or via mise from tools/cli/source:
mise run generate
mise run generate:check
```

Generation is deterministic and operationId-driven; only operations marked
`x-platform-visibility: PUBLIC` are included, and registry rows are sorted by
operationId. The generated outputs are `src/generated/commands.gen.ts`,
`src/generated/openapi-api.gen.ts`, and
`src/generated/public-operation-executor.gen.ts`. Never hand-edit generated
files; run `bazel run //tools/cli:write_generated` and commit the result.

See [docs/architecture.md](docs/architecture.md) for the full command
derivation rules, the API/auth/config model, output modes, exit codes, and
the rest of the CLI's design contract.

## Testing

```sh
bun test
```

`mise run check` (drift check, build, tests) is the required gate before
release changes; see [docs/architecture.md](docs/architecture.md#testing-strategy)
for what current test coverage includes.

## Release process

Bump `package.json` `version` in a reviewed cnap PR. That value is the only
version source for a future cnap-owned public `v*` tag. The legacy
release-please files remain while the replacement publisher is disabled.

`mise run release:package` cross-compiles all five targets, creates archives
and checksums in `dist/release`, and verifies their manifest.
`mise run release:verify` re-verifies an already-packaged release directory.
`mise run release:smoke` extracts and runs the artifact for the current
supported host. Authoritative archive labels under `//tools/cli:release_archive_*`
are named for the published-source-view config; real Bazel compile wiring and
the macOS/Windows native-smoke authority are still open (design §9).

The previous public Release Please workflows are disabled. A future monorepo
publisher must create immutable tags and assets from admitted Bazel outputs,
then hand the verified manifest to the Homebrew tap through Access Proxy.
The publisher is not active in this planning phase.

`akua-dev/homebrew-tap` owns the `akua` formula, formula tests, and the
reviewed formula-update PR. This repository requests a formula PR only after
every archive has passed a native install smoke test and all published assets
have passed post-upload verification; it never pushes formula commits itself.

`scripts/release.ts` remains the source of truth for target IDs, Bun targets,
archive names, executable names, SHA-256 files, and release manifests until the
Bazel archive targets produce equivalent bytes.

## Repository-specific engineering rules

See [AGENTS.md](AGENTS.md) for durable, repository-wide engineering rules
(Effect v4 production code conventions, the release contract, ownership
boundaries, and the public API command contract) that apply to any change in
`src/` or `scripts/`.
