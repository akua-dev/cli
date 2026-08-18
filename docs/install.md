# Manual install from GitHub Releases

[Homebrew](../README.md#install) is the supported install path for almost
everyone. Use this page only when Homebrew isn't available — for example, a
Linux host without Homebrew, or a CI environment that wants a pinned,
checksummed binary instead of going through a package manager.

Every GitHub Release archive contains the `akua` executable and its
adjacent target-native package runtime, and has an adjacent SHA-256 file. A
release also publishes `checksums.txt` and a complete release manifest.

## macOS or Linux

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

## Windows x64

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

## Supported release artifacts

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
