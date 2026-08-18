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

The formula is maintained in `akua-dev/homebrew-tap`.

No Homebrew? See [manual install](docs/install.md) for checksummed release
archives.

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

## Learn more

The full command reference and platform guides live at
[docs.akua.dev](https://docs.akua.dev).

Contributing to this repo? See [CONTRIBUTING.md](CONTRIBUTING.md).
