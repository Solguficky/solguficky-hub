#!/usr/bin/env bash
# Provisions a Debian/Ubuntu x86_64 image so that `just verify` passes from a
# fresh checkout without manual steps. Consumers: the Cursor cloud agent
# (.cursor/environment.json) and any other Linux host that runs the task loop.
# CI does not run it: its jobs install only what each of them needs.
#
# Usage: bash tools/env/install.sh
#
# Versions are not constants here. Each one is read from the file that already
# pins it: the justfile (just, protoc, lefthook, skillshare, Node), global.json
# (.NET SDK), apps/identity/go.mod (Go), apps/auction/.java-version (JDK); sbt
# downloads the version from apps/auction/project/build.properties itself.
#
# Idempotent: every step first checks the installed version and skips when it
# matches, so a second run installs nothing new. Repository recipes at the end
# (`just tools`, `just skillshare-install`) are idempotent on their own.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

log() { printf '\n=== %s ===\n' "$1"; }

# --- System packages ---------------------------------------------------------

APT_PACKAGES="ca-certificates curl gnupg unzip git pkg-config libssl-dev libicu-dev python3 python3-pip python-is-python3"
apt_updated=no
apt_install() {
  if [ "$apt_updated" = no ]; then
    $SUDO apt-get update -qq
    apt_updated=yes
  fi
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
}

missing_packages=""
for pkg in $APT_PACKAGES; do
  dpkg -s "$pkg" >/dev/null 2>&1 || missing_packages="$missing_packages $pkg"
done
if [ -n "$missing_packages" ]; then
  log "Installing system packages:$missing_packages"
  # shellcheck disable=SC2086
  apt_install $missing_packages
else
  log "System packages already installed"
fi

$SUDO install -d -m 0755 /etc/apt/keyrings

# Read the way CI reads them, so that `just` itself can be pinned too.
pinned() { sed -n "s/^$1 *:= *\"\\([^\"]*\\)\".*/\\1/p" justfile; }

JUST_VERSION="$(pinned JUST_VERSION)"
PROTOC_VERSION="$(pinned PROTOC_VERSION)"
PROTOC_SHA256="$(pinned PROTOC_SHA256)"
LEFTHOOK_VERSION="$(pinned LEFTHOOK_VERSION)"
SKILLSHARE_VERSION="$(pinned SKILLSHARE_VERSION)"
NODE_MAJOR="$(pinned NODE_MAJOR)"
DOTNET_SDK_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' global.json | head -n 1)"
GO_VERSION="$(awk '/^go [0-9]/ {print $2; exit}' apps/identity/go.mod)"
JAVA_MAJOR="$(tr -d '[:space:]' < apps/auction/.java-version)"

for version in JUST_VERSION PROTOC_VERSION PROTOC_SHA256 LEFTHOOK_VERSION SKILLSHARE_VERSION NODE_MAJOR DOTNET_SDK_VERSION GO_VERSION JAVA_MAJOR; do
  if [ -z "${!version}" ]; then
    echo "install.sh: $version is not pinned where this script reads it" >&2
    exit 1
  fi
done

# --- just --------------------------------------------------------------------

# --tag skips the installer's GitHub API lookup of the latest release, which
# anonymous clients hit a rate limit on.
if [ "$(just --version 2>/dev/null | awk '{print $2}')" != "$JUST_VERSION" ]; then
  log "Installing just $JUST_VERSION"
  curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | \
    $SUDO bash -s -- --tag "$JUST_VERSION" --to /usr/local/bin --force
else
  log "just $JUST_VERSION already installed"
fi

# --- Go ----------------------------------------------------------------------

# GOTOOLCHAIN pins the compiler to go.mod even when the image ships a newer Go
# (docs/learning/go/service-layout.md); a missing Go is installed at that version.
export GOTOOLCHAIN="go${GO_VERSION}"
if ! command -v go >/dev/null 2>&1; then
  log "Installing Go $GO_VERSION"
  curl -fsSL -o /tmp/go.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
  $SUDO rm -rf /usr/local/go
  $SUDO tar -C /usr/local -xzf /tmp/go.tar.gz
  $SUDO ln -sf /usr/local/go/bin/go /usr/local/bin/go
  $SUDO ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
else
  log "Go already installed; toolchain pinned to $GOTOOLCHAIN"
fi
GOBIN_DIR="$(go env GOPATH)/bin"
export PATH="$GOBIN_DIR:$PATH"

# --- .NET SDK ----------------------------------------------------------------

DOTNET_DIR="/usr/local/dotnet"
if ! "$DOTNET_DIR/dotnet" --list-sdks 2>/dev/null | grep -q "^${DOTNET_SDK_VERSION} "; then
  log "Installing .NET SDK $DOTNET_SDK_VERSION from global.json"
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
  $SUDO bash /tmp/dotnet-install.sh --jsonfile "$REPO_ROOT/global.json" --install-dir "$DOTNET_DIR" --no-path
else
  log ".NET SDK $DOTNET_SDK_VERSION already installed"
fi
$SUDO ln -sf "$DOTNET_DIR/dotnet" /usr/local/bin/dotnet

# --- protoc ------------------------------------------------------------------

PROTOC_DIR="/usr/local/protoc${PROTOC_VERSION}"
if [ "$(protoc --version 2>/dev/null | awk '{print $2}')" != "$PROTOC_VERSION" ]; then
  log "Installing protoc $PROTOC_VERSION"
  curl -fsSL -o /tmp/protoc.zip \
    "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-x86_64.zip"
  echo "${PROTOC_SHA256}  /tmp/protoc.zip" | sha256sum -c -
  $SUDO rm -rf "$PROTOC_DIR"
  $SUDO mkdir -p "$PROTOC_DIR"
  $SUDO unzip -oq /tmp/protoc.zip -d "$PROTOC_DIR"
  $SUDO ln -sf "$PROTOC_DIR/bin/protoc" /usr/local/bin/protoc
else
  log "protoc $PROTOC_VERSION already installed"
fi

# --- Node.js -----------------------------------------------------------------

# `|| true`: under pipefail a missing binary would abort the script here.
node_major="$(node --version 2>/dev/null | sed -n 's/^v\([0-9]*\)\..*/\1/p' || true)"
if [ -z "$node_major" ] || [ "$node_major" -lt "$NODE_MAJOR" ]; then
  log "Installing Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO bash -
  apt_updated=yes
  apt_install nodejs
else
  log "Node.js $node_major already installed"
fi

# --- JDK and sbt -------------------------------------------------------------

java_major="$(java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -n 1 || true)"
if [ "$java_major" != "$JAVA_MAJOR" ]; then
  log "Installing Temurin JDK $JAVA_MAJOR"
  if [ ! -f /etc/apt/keyrings/adoptium.gpg ]; then
    curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | \
      gpg --dearmor | $SUDO tee /etc/apt/keyrings/adoptium.gpg >/dev/null
    echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb $(. /etc/os-release && echo "$VERSION_CODENAME") main" | \
      $SUDO tee /etc/apt/sources.list.d/adoptium.list >/dev/null
    apt_updated=no
  fi
  apt_install "temurin-${JAVA_MAJOR}-jdk"
  # An image with another JDK keeps it as the default: point java at this one.
  jdk_home="/usr/lib/jvm/temurin-${JAVA_MAJOR}-jdk-amd64"
  $SUDO update-alternatives --set java "$jdk_home/bin/java"
  $SUDO update-alternatives --set javac "$jdk_home/bin/javac"
else
  log "JDK $JAVA_MAJOR already installed"
fi

if ! command -v sbt >/dev/null 2>&1; then
  log "Installing sbt"
  if [ ! -f /etc/apt/keyrings/sbt.gpg ]; then
    curl -fsSL "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x2EE0EA64E40A89B84B2DF73499E82A75642AC823" | \
      gpg --dearmor | $SUDO tee /etc/apt/keyrings/sbt.gpg >/dev/null
    echo "deb [signed-by=/etc/apt/keyrings/sbt.gpg] https://repo.scala-sbt.org/scalasbt/debian all main" | \
      $SUDO tee /etc/apt/sources.list.d/sbt.list >/dev/null
    apt_updated=no
  fi
  apt_install sbt
else
  log "sbt already installed"
fi

# --- lefthook and skillshare -------------------------------------------------

if [ "$(lefthook version 2>/dev/null)" != "$LEFTHOOK_VERSION" ]; then
  log "Installing lefthook $LEFTHOOK_VERSION"
  go install "github.com/evilmartians/lefthook/v2@v${LEFTHOOK_VERSION}"
  $SUDO ln -sf "$GOBIN_DIR/lefthook" /usr/local/bin/lefthook
else
  log "lefthook $LEFTHOOK_VERSION already installed"
fi

if ! skillshare version 2>/dev/null | grep -q "v${SKILLSHARE_VERSION}"; then
  log "Installing skillshare $SKILLSHARE_VERSION"
  # Not `go install`: the module declares its path as `skillshare`, so only the
  # release archive installs; it is checked against the release checksums.
  archive="skillshare_${SKILLSHARE_VERSION}_linux_amd64.tar.gz"
  release="https://github.com/runkids/skillshare/releases/download/v${SKILLSHARE_VERSION}"
  curl -fsSL -o "/tmp/$archive" "$release/$archive"
  curl -fsSL -o /tmp/skillshare-checksums.txt "$release/checksums.txt"
  (cd /tmp && grep " ${archive}\$" skillshare-checksums.txt | sha256sum -c -)
  $SUDO tar -C /usr/local/bin -xzf "/tmp/$archive" skillshare
else
  log "skillshare $SKILLSHARE_VERSION already installed"
fi

# --- Repository recipes ------------------------------------------------------

# Debian marks the system Python externally managed (PEP 668); the image is
# disposable, so nats-tester goes into it directly, as it did before.
export PIP_BREAK_SYSTEM_PACKAGES=1

log "Installing component tooling (just tools)"
just tools

# The recipes install into GOPATH/bin and ~/.local/bin; later shells of the
# agent do not source this script, so the binaries are linked into PATH.
for bin in "$GOBIN_DIR"/* "$HOME/.local/bin/nats-tester"; do
  if [ -x "$bin" ]; then
    $SUDO ln -sf "$bin" "/usr/local/bin/$(basename "$bin")"
  fi
done

log "Installing git hooks (just setup)"
just setup

log "Installing external skills (just skillshare-install)"
just skillshare-install
# --all lays out subagent roles too; without it they stay empty silently.
skillshare sync --all -p

log "Environment setup complete"
