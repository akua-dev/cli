# Akua CLI

`akua` drives Akua Cloud from a terminal: create Kubernetes clusters, add
machines, package an application, and install it, all from one command. It is
a single self-contained executable, built for three audiences — a person
typing commands interactively, a CI pipeline calling it non-interactively, and
a coding agent driving it programmatically — and every command adapts its
output to whichever one is running it.

Every command is generated directly from Akua's public API, so the CLI never
drifts out of sync with what the platform can actually do.

The canonical executable is `akua`; there is no `cnap` compatibility binary.

## Install

GitHub Releases and Homebrew are the supported install channels. Every GitHub
archive contains the `akua` executable and its adjacent target-native package
runtime, and has an adjacent SHA-256 file. A release also publishes
`checksums.txt`, a complete release manifest, and the exact Homebrew
artifact/checksum mapping.

### Homebrew

```sh
brew install akua-dev/tap/akua
akua --version
akua --help
akua commands --limit 1
akua pkg version
```

Upgrade with:

```sh
brew update
brew upgrade akua
```

The formula is maintained in `akua-dev/homebrew-tap`. A CLI release requests a
reviewed formula PR only after every archive has passed a native install smoke
test and all published assets have passed post-upload verification.

### GitHub Release: macOS or Linux

This copy-paste example installs v0.10.1 into `~/.local/bin`. Change `VERSION`
when selecting a newer release.

```sh
set -eu
VERSION=0.10.1
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
INSTALL_ROOT="$HOME/.local/libexec/akua-v${VERSION}"
mkdir -p "$INSTALL_ROOT" "$HOME/.local/bin"
tar -xzf "$ASSET" -C "$INSTALL_ROOT"
ln -sfn "$INSTALL_ROOT/akua" "$HOME/.local/bin/akua"
"$HOME/.local/bin/akua" --version
"$HOME/.local/bin/akua" --help
"$HOME/.local/bin/akua" commands --limit 1
"$HOME/.local/bin/akua" pkg version
```

Ensure `~/.local/bin` is on `PATH`. Manual upgrades repeat these steps with a
newer `VERSION`, replacing `~/.local/bin/akua`. The CLI does not self-update.

### GitHub Release: Windows x64

Run in PowerShell. This installs v0.10.1 into `%USERPROFILE%\bin`; add that
directory to the user `PATH` if it is not already present.

```powershell
$ErrorActionPreference = "Stop"
$Version = "0.10.1"
$Asset = "akua-v$Version-windows-x64.zip"
$Base = "https://github.com/akua-dev/cli/releases/download/v$Version"
Invoke-WebRequest "$Base/$Asset" -OutFile $Asset
Invoke-WebRequest "$Base/$Asset.sha256" -OutFile "$Asset.sha256"
$Expected = ((Get-Content "$Asset.sha256") -split "\s+")[0].ToLower()
$Actual = (Get-FileHash $Asset -Algorithm SHA256).Hash.ToLower()
if ($Actual -ne $Expected) { throw "SHA-256 mismatch for $Asset" }
Expand-Archive $Asset -DestinationPath .\akua-release -Force
$InstallRoot = "$HOME\libexec\akua-v$Version"
New-Item -ItemType Directory -Force "$InstallRoot" | Out-Null
Copy-Item .\akua-release\* "$InstallRoot" -Recurse -Force
New-Item -ItemType Directory -Force "$HOME\bin" | Out-Null
Copy-Item "$InstallRoot\akua.exe" "$HOME\bin\akua.exe" -Force
Copy-Item "$InstallRoot\node_modules" "$HOME\bin\node_modules" -Recurse -Force
& "$HOME\bin\akua.exe" --version
& "$HOME\bin\akua.exe" --help
& "$HOME\bin\akua.exe" commands --limit 1
& "$HOME\bin\akua.exe" pkg version
```

### Supported release artifacts

| Platform | Architecture | Asset | Runtime baseline |
| --- | --- | --- | --- |
| macOS | Apple Silicon arm64 | `akua-v0.10.1-darwin-arm64.tar.gz` | Bun darwin arm64 |
| macOS | Intel x64 | `akua-v0.10.1-darwin-x64.tar.gz` | Bun darwin x64 |
| Linux | glibc arm64 | `akua-v0.10.1-linux-arm64.tar.gz` | Bun linux arm64 |
| Linux | glibc x64 | `akua-v0.10.1-linux-x64.tar.gz` | Bun linux x64 baseline |
| Windows | x64 | `akua-v0.10.1-windows-x64.zip` | Bun windows x64 baseline |

Linux musl, Windows arm64, and other systems are not in the tested release
contract. x64 Linux and Windows use Bun's baseline target for older CPUs. Unix
archives preserve executable mode `0755`; the Windows ZIP contains `akua.exe`.
All archives also contain the target-native package runtime under
`node_modules/@akua-dev`. Keep that directory adjacent to the executable. Bun is
not required on the target machine.

To audit a whole release, download `checksums.txt` plus the archives and run
`sha256sum --check checksums.txt` on Linux or `shasum -a 256 --check
checksums.txt` on macOS. The adjacent `<asset>.sha256` files support single-asset
verification. Release assets are never replaced in place; a changed binary
requires a new version.

## First commands

```sh
akua                         # complete interactive command tree
akua auth --help              # authentication subcommands and options
akua workspaces --help        # generated resource commands
akua commands --limit 5       # discover the full command surface
```

## Sign in

For an interactive browser/device login:

```sh
akua auth login
```

The CLI prints a verification URL and code, then attempts to open the URL in a
browser. Use `--no-browser` when the machine cannot open a browser; complete
the verification in any browser instead.

```sh
akua auth login --no-browser
```

For CI and coding agents, prefer an ephemeral environment credential instead of
an interactive login:

```sh
export AKUA_API_TOKEN='sk_akua_...'
akua auth status
```

For a local persisted token without an interactive login:

```sh
akua auth login --token 'sk_akua_...'
akua auth status
akua auth logout
```

`AKUA_API_TOKEN` takes precedence over a stored token. Login writes
`~/.config/akua/config.json`; the directory is forced to `0700` and the file to
`0600`. Login replaces only `token` and preserves unknown config keys. Logout
removes only the stored `token`, also preserving unknown config keys, and cannot
clear `AKUA_API_TOKEN` from the parent process.

## Built for humans, CI, and agents

An interactive TTY defaults to human prose. The CLI switches to compact agent
output automatically when any of these signals are active, so an agent gets
usable output without extra flags:

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

## Discover and run commands

Every public Akua operation is available as a generated command, kept current
with the API automatically. Discover the current surface instead of relying on
a fixed list:

```sh
akua commands --json
akua commands --resource workspaces
akua commands --operation-id workspaces.list
```

For example, `operationId: workspaces.list` becomes `akua workspaces list`.
Generated commands accept one JSON object from stdin or a named file. Its only
keys are `path`, `query`, `headers`, and `body`:

```sh
printf '{"query":{"limit":5}}' | akua workspaces list --input -
akua machines create --input - < ./machine.json
```

Request input is schema-validated before it is sent and never included in
diagnostics. The CLI stays provider-neutral: it has no provider-specific commands,
flags, environment variables, or credential loaders. Provider-specific values
belong only in the generated request body.

## Development

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

The command surface is generated from the public source of truth,
`https://api.akua.dev/v1/openapi.json`:

```sh
mise run spec:fetch       # fetch and stably format openapi/public.json
mise run generate         # regenerate the command registry and typed API bindings
mise run generate:check   # fail if committed generated output has drifted
mise run check            # drift check, typecheck/build, and tests
```

Generation is deterministic and operationId-driven; only operations marked
`x-platform-visibility: PUBLIC` are included, and registry rows are sorted by
operationId. The generated outputs are `src/generated/commands.gen.ts`,
`src/generated/openapi-api.gen.ts`, and
`src/generated/public-operation-executor.gen.ts`.

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
