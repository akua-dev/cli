# Akua CLI

`akua` is the public Akua Cloud command-line interface. It is a self-contained
Bun/TypeScript executable for humans, automation, and coding agents. The current
MVP implements local token authentication, adaptive structured output, and
discovery of the public operationId-driven command registry. Generated API
commands are discoverable but not yet executable unless `akua --help` says so.

The canonical executable is `akua`; there is no `cnap` compatibility binary.

## Install

GitHub Releases and Homebrew are the supported install channels. Every GitHub
archive contains one executable and has an adjacent SHA-256 file. A release also
publishes `checksums.txt`, a complete release manifest, and the exact Homebrew
artifact/checksum mapping.

### Homebrew

```sh
brew install akua-dev/tap/akua
akua --version
akua --help
akua commands --limit 1
```

Upgrade or reinstall with:

```sh
brew update
brew upgrade akua
```

The formula is maintained in `akua-dev/homebrew-tap`. A CLI release requests a
reviewed formula PR only after all immutable GitHub Release assets have passed
native install smoke tests and post-upload checksum verification.

### GitHub Release: macOS or Linux

This copy-paste example installs v0.8.0 into `~/.local/bin`. Change `VERSION`
when selecting a newer release.

```sh
set -eu
VERSION=0.8.0
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  TARGET=darwin-arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64 ;;
  Linux-arm64|Linux-aarch64) TARGET=linux-arm64 ;;
  Linux-x86_64) TARGET=linux-x64 ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
ASSET="akua-v${VERSION}-${TARGET}.tar.gz"
BASE="https://github.com/akua-dev/cli/releases/download/v${VERSION}"
curl --fail --location --remote-name "${BASE}/${ASSET}"
curl --fail --location --remote-name "${BASE}/${ASSET}.sha256"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum --check "${ASSET}.sha256"
else
  shasum -a 256 --check "${ASSET}.sha256"
fi
tar -xzf "$ASSET"
mkdir -p "$HOME/.local/bin"
install -m 0755 akua "$HOME/.local/bin/akua"
"$HOME/.local/bin/akua" --version
"$HOME/.local/bin/akua" --help
"$HOME/.local/bin/akua" commands --limit 1
```

Ensure `~/.local/bin` is on `PATH`. Manual upgrades repeat these steps with a
newer `VERSION`, replacing `~/.local/bin/akua`. The CLI does not self-update.

### GitHub Release: Windows x64

Run in PowerShell. This installs v0.8.0 into `%USERPROFILE%\bin`; add that
directory to the user `PATH` if it is not already present.

```powershell
$ErrorActionPreference = "Stop"
$Version = "0.8.0"
$Asset = "akua-v$Version-windows-x64.zip"
$Base = "https://github.com/akua-dev/cli/releases/download/v$Version"
Invoke-WebRequest "$Base/$Asset" -OutFile $Asset
Invoke-WebRequest "$Base/$Asset.sha256" -OutFile "$Asset.sha256"
$Expected = ((Get-Content "$Asset.sha256") -split "\s+")[0].ToLower()
$Actual = (Get-FileHash $Asset -Algorithm SHA256).Hash.ToLower()
if ($Actual -ne $Expected) { throw "SHA-256 mismatch for $Asset" }
Expand-Archive $Asset -DestinationPath .\akua-release -Force
New-Item -ItemType Directory -Force "$HOME\bin" | Out-Null
Copy-Item .\akua-release\akua.exe "$HOME\bin\akua.exe" -Force
& "$HOME\bin\akua.exe" --version
& "$HOME\bin\akua.exe" --help
& "$HOME\bin\akua.exe" commands --limit 1
```

### Supported release artifacts

| Platform | Architecture | Asset | Runtime baseline |
| --- | --- | --- | --- |
| macOS | Apple Silicon arm64 | `akua-v0.8.0-darwin-arm64.tar.gz` | Bun darwin arm64 |
| macOS | Intel x64 | `akua-v0.8.0-darwin-x64.tar.gz` | Bun darwin x64 |
| Linux | glibc arm64 | `akua-v0.8.0-linux-arm64.tar.gz` | Bun linux arm64 |
| Linux | glibc x64 | `akua-v0.8.0-linux-x64.tar.gz` | Bun linux x64 baseline |
| Windows | x64 | `akua-v0.8.0-windows-x64.zip` | Bun windows x64 baseline |

Linux musl, Windows arm64, and other systems are not in the tested release
contract. x64 Linux and Windows use Bun's baseline target for older CPUs. Unix
archives preserve executable mode `0755`; the Windows ZIP contains `akua.exe`.
The binaries are self-contained and do not require Bun to be installed.

To audit a whole release, download `checksums.txt` plus the archives and run
`sha256sum --check checksums.txt`. The adjacent `<asset>.sha256` files support
single-asset verification. Release assets are never replaced in place; a
changed binary requires a new version.

## First use and authentication

Inspect the installed surface first:

```sh
akua --version
akua --help
akua commands --limit 5
```

For CI and coding agents, prefer an ephemeral environment credential:

```sh
export AKUA_API_TOKEN='sk_akua_...'
akua auth status
```

For a local persisted token:

```sh
akua auth login --token 'sk_akua_...'
akua auth status
akua auth logout
```

`AKUA_API_TOKEN` takes precedence over a stored token. Login writes
`~/.config/akua/config.json`; the directory is forced to `0700` and the file to
`0600`. Login replaces only `token` and preserves unknown config keys. Logout
removes only the stored `token`, also preserving unknown config keys, and cannot
clear `AKUA_API_TOKEN` from the parent process. Browser/device login is not part
of this MVP.

## Human and agent output

An interactive TTY defaults to human prose. The CLI defaults to compact agent
output when any of these signals are active:

- `AGENT=true` or `AGENT=<name>` (for example `AGENT=codex`);
- a detected provider environment such as Codex, Claude Code, Cursor, Aider,
  Devin, OpenCode, Amp, Cody, Replit, or Windsurf;
- CI providers including GitHub Actions, GitLab CI, Buildkite, CircleCI,
  Jenkins, TeamCity, or Azure Pipelines;
- non-TTY stdout.

Values `AGENT=0`, `AGENT=false`, and an empty `AGENT` do not activate agent mode.
Explicit output flags win over detection:

```sh
akua commands --output human
akua commands --output agent
akua commands --json
akua commands --quiet
AKUA_OUTPUT=json akua auth status
```

The supported modes are `human`, `agent`, `json`, and `quiet`. Success data is
written to stdout; progress and warnings belong on stderr. Unknown commands,
flags, and output modes fail loudly with stable nonzero exit codes.

## OpenAPI command generation

The public source of truth is
`https://api.akua.dev/v1/openapi.json`. The workflow is deliberately explicit:

```sh
mise run spec:fetch       # fetch and stably format openapi/public.json
mise run generate         # derive src/generated/commands.gen.ts
mise run generate:check   # fail if committed generated output has drifted
mise run check            # drift check, typecheck/build, and tests
```

Generation is deterministic and operationId-driven. Only operations marked
`x-platform-visibility: PUBLIC` are included. For example,
`operationId: workspaces.list` becomes `akua workspaces list`; registry rows are
sorted by operationId.

The scheduled update workflow fetches and generates, then opens or updates a PR
only when `openapi/public.json` or `src/generated/commands.gen.ts` changed. It
fails if any other file changes. Re-running against an unchanged spec is a no-op,
so OpenAPI updates remain idempotent and scope-limited.

## CLI-owned agent skill

The canonical source skill is
[`skills/agent-skills-standard-following/SKILL.md`](skills/agent-skills-standard-following/SKILL.md).
From a clone, point a coding agent at that file or copy the directory into the
agent's normal local skills directory. The source can also be audited directly:

```sh
curl --fail --location \
  https://raw.githubusercontent.com/akua-dev/cli/main/skills/agent-skills-standard-following/SKILL.md
```

The separate `akua-dev/skills` repository owns importing and syncing this source.
It is private today and is not claimed here as a publicly installable channel.

## Development and release validation

Prerequisites are [mise](https://mise.jdx.dev/) and the pinned Bun toolchain:

```sh
mise install
bun install --frozen-lockfile
mise run check
mise run build:binary
./dist/akua --version
./dist/akua --help
./dist/akua commands --limit 1
```

`mise run release:package` cross-compiles all five targets, creates archives and
checksums in `dist/release`, and verifies their manifest. `mise run
release:smoke` extracts and runs the artifact for the current supported host.
CI repeats native smoke tests on every platform in the table.

Release Please creates the version tag and GitHub Release. Its own workflow then
calls artifact publication directly, so publication does not depend on a tag
event that GitHub may suppress for job-token-created tags. Uploads do not
clobber existing assets. Only after downloading and re-verifying the published
assets does the workflow dispatch the Homebrew manifest URL. The
`HOMEBREW_TAP_TOKEN` secret must be a fine-grained credential scoped only to the
tap repository's dispatch permission; failures remain visible as release job
failures.

See [docs/architecture.md](docs/architecture.md) for the broader CLI contract.
