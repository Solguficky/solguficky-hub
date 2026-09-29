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
# (.NET SDK), apps/identity/go.mod (Go), apps/auction/.java-version (JDK),
# infra/apphost/AppHost/AppHost.csproj (Aspire CLI bundle); sbt
# downloads the version from apps/auction/project/build.properties itself.
#
# Idempotent: every step first checks the installed version and skips when it
# matches, so a second run installs nothing new. Repository recipes at the end
# (`just tools`, `just skillshare-install`) are idempotent on their own.
#
# Restricted egress: a sandbox that allows GitHub releases and package
# registries but denies vendor installers (the Claude Code cloud container
# denies just.systems, dot.net, deb.nodesource.com, packages.adoptium.net and
# repo.scala-sbt.org) gets each such tool from the first reachable fallback:
# just and sbt from their GitHub releases with checksums, the .NET SDK from the
# official SDK image, the JDK from packages.microsoft.com. The same step also
# starts an installed but stopped Docker daemon: the contour (L2) needs it.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

log() { printf '\n=== %s ===\n' "$1"; }

# A GET of the first byte, not HEAD: some hosts reject HEAD. A denied CONNECT
# through the egress proxy and a missing host both land here as "unreachable".
reachable() { curl -fsSL -o /dev/null --max-time 15 -r 0-0 "$1" 2>/dev/null; }

# Downloads are unpacked and run through sudo, so they go into a private
# directory: a predictable path in /tmp could be planted by another user.
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

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
ASPIRE_SDK_VERSION="$(sed -n 's/.*<Sdk Name="Aspire.AppHost.Sdk" Version="\([^"]*\)".*/\1/p' infra/apphost/AppHost/AppHost.csproj)"

for version in JUST_VERSION PROTOC_VERSION PROTOC_SHA256 LEFTHOOK_VERSION SKILLSHARE_VERSION NODE_MAJOR DOTNET_SDK_VERSION GO_VERSION JAVA_MAJOR ASPIRE_SDK_VERSION; do
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
  if reachable https://just.systems/install.sh; then
    curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | \
      $SUDO bash -s -- --tag "$JUST_VERSION" --to /usr/local/bin --force
  else
    archive="just-${JUST_VERSION}-x86_64-unknown-linux-musl.tar.gz"
    release="https://github.com/casey/just/releases/download/${JUST_VERSION}"
    curl -fsSL -o "$WORK_DIR/$archive" "$release/$archive"
    curl -fsSL -o "$WORK_DIR/just-SHA256SUMS" "$release/SHA256SUMS"
    (cd "$WORK_DIR" && grep " ${archive}\$" just-SHA256SUMS | sha256sum -c -)
    $SUDO tar -C /usr/local/bin -xzf "$WORK_DIR/$archive" just
  fi
else
  log "just $JUST_VERSION already installed"
fi

# --- Go ----------------------------------------------------------------------

# GOTOOLCHAIN pins the compiler to go.mod even when the image ships a newer Go
# (docs/learning/go/service-layout.md); a missing Go is installed at that version.
# A Go older than 1.21 does not know GOTOOLCHAIN, so it counts as missing.
# The pin is saved with `go env -w` so that later shells of the agent keep it.
go_minor="$(GOTOOLCHAIN=local go version 2>/dev/null | sed -n 's/.* go1\.\([0-9]*\).*/\1/p' || true)"
export GOTOOLCHAIN="go${GO_VERSION}"
if [ -z "$go_minor" ] || [ "$go_minor" -lt 21 ]; then
  log "Installing Go $GO_VERSION"
  curl -fsSL -o "$WORK_DIR/go.tar.gz" "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
  $SUDO rm -rf /usr/local/go
  $SUDO tar -C /usr/local -xzf "$WORK_DIR/go.tar.gz"
  $SUDO ln -sf /usr/local/go/bin/go /usr/local/bin/go
  $SUDO ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
else
  log "Go already installed; toolchain pinned to $GOTOOLCHAIN"
fi
GOBIN_DIR="$(go env GOPATH)/bin"
export PATH="$GOBIN_DIR:$PATH"
go env -w GOTOOLCHAIN="go${GO_VERSION}"

# --- .NET SDK ----------------------------------------------------------------

# Started before .NET: the SDK fallback copies it out of an image. The daemon
# stays up for later shells, which is what the contour recipes expect.
if command -v dockerd >/dev/null 2>&1 && ! $SUDO docker info >/dev/null 2>&1; then
  log "Starting the Docker daemon"
  $SUDO sh -c 'nohup dockerd >/var/log/dockerd.log 2>&1 &'
  for _ in $(seq 1 30); do
    $SUDO docker info >/dev/null 2>&1 && break
    sleep 1
  done
  $SUDO docker info >/dev/null 2>&1 || { echo "install.sh: dockerd did not start, see /var/log/dockerd.log" >&2; exit 1; }
fi

# Satisfied is decided by the SDK itself: `dotnet --version` in the repository
# root resolves global.json with its rollForward, so a newer feature band that
# the fallback image brings counts, and an older one does not.
DOTNET_DIR="/usr/local/dotnet"
if ! (cd "$REPO_ROOT" && "$DOTNET_DIR/dotnet" --version >/dev/null 2>&1); then
  log "Installing .NET SDK $DOTNET_SDK_VERSION from global.json"
  if reachable https://dot.net/v1/dotnet-install.sh; then
    curl -fsSL https://dot.net/v1/dotnet-install.sh -o "$WORK_DIR/dotnet-install.sh"
    $SUDO bash "$WORK_DIR/dotnet-install.sh" --jsonfile "$REPO_ROOT/global.json" --install-dir "$DOTNET_DIR" --no-path
  else
    sdk_image="mcr.microsoft.com/dotnet/sdk:${DOTNET_SDK_VERSION%.*}"
    $SUDO docker pull -q "$sdk_image"
    container="$($SUDO docker create "$sdk_image")"
    $SUDO rm -rf "$DOTNET_DIR"
    $SUDO docker cp "$container:/usr/share/dotnet" "$DOTNET_DIR"
    $SUDO docker rm "$container" >/dev/null
    (cd "$REPO_ROOT" && "$DOTNET_DIR/dotnet" --version >/dev/null) || {
      echo "install.sh: $sdk_image does not satisfy global.json ($DOTNET_SDK_VERSION)" >&2
      exit 1
    }
  fi
else
  log ".NET SDK $DOTNET_SDK_VERSION already installed"
fi
$SUDO ln -sf "$DOTNET_DIR/dotnet" /usr/local/bin/dotnet
$SUDO ln -sf "$DOTNET_DIR/dnx" /usr/local/bin/dnx

# The AppHost build (AspireUseCliBundle) needs the Aspire CLI bundle of its own
# SDK version in ~/.aspire. The build can set it up through dnx itself, but
# gives that 120 seconds, which a slow network does not meet (ASPIRE009), so it
# is set up here without a deadline. A second run reports it is up to date.
# --nologo: the banner crashes the CLI (ArgumentOutOfRangeException) when the
# terminal reports zero width, which is how an agent's shell looks to it.
log "Setting up the Aspire CLI bundle $ASPIRE_SDK_VERSION"
dnx --yes "aspire.cli@${ASPIRE_SDK_VERSION}" -- setup --install-path "$HOME/.aspire" --nologo

# --- protoc ------------------------------------------------------------------

PROTOC_DIR="/usr/local/protoc${PROTOC_VERSION}"
if [ "$(protoc --version 2>/dev/null | awk '{print $2}')" != "$PROTOC_VERSION" ]; then
  log "Installing protoc $PROTOC_VERSION"
  curl -fsSL -o "$WORK_DIR/protoc.zip" \
    "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-x86_64.zip"
  echo "${PROTOC_SHA256}  $WORK_DIR/protoc.zip" | sha256sum -c -
  $SUDO rm -rf "$PROTOC_DIR"
  $SUDO mkdir -p "$PROTOC_DIR"
  $SUDO unzip -oq "$WORK_DIR/protoc.zip" -d "$PROTOC_DIR"
  $SUDO ln -sf "$PROTOC_DIR/bin/protoc" /usr/local/bin/protoc
else
  log "protoc $PROTOC_VERSION already installed"
fi

# --- Node.js -----------------------------------------------------------------

# `|| true`: under pipefail a missing binary would abort the script here.
node_major="$(node --version 2>/dev/null | sed -n 's/^v\([0-9]*\)\..*/\1/p' || true)"
if [ "$node_major" != "$NODE_MAJOR" ]; then
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
  # Keyed on the source file, written last: a run cut off after the key
  # rewrites both.
  if reachable https://packages.adoptium.net/artifactory/api/gpg/key/public; then
    log "Installing Temurin JDK $JAVA_MAJOR"
    jdk_package="temurin-${JAVA_MAJOR}-jdk"
    if [ ! -f /etc/apt/sources.list.d/adoptium.list ]; then
      curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | \
        gpg --dearmor | $SUDO tee /etc/apt/keyrings/adoptium.gpg >/dev/null
      echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb $(. /etc/os-release && echo "$VERSION_CODENAME") main" | \
        $SUDO tee /etc/apt/sources.list.d/adoptium.list >/dev/null
      apt_updated=no
    fi
  else
    # Another OpenJDK build of the same major: the pin is the major version.
    log "Installing Microsoft Build of OpenJDK $JAVA_MAJOR"
    jdk_package="msopenjdk-${JAVA_MAJOR}"
    if [ ! -f /etc/apt/sources.list.d/microsoft-prod.list ]; then
      curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | \
        gpg --dearmor | $SUDO tee /etc/apt/keyrings/microsoft.gpg >/dev/null
      echo "deb [signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/ubuntu/$(. /etc/os-release && echo "$VERSION_ID")/prod $(. /etc/os-release && echo "$VERSION_CODENAME") main" | \
        $SUDO tee /etc/apt/sources.list.d/microsoft-prod.list >/dev/null
      apt_updated=no
    fi
  fi
  apt_install "$jdk_package"
  # An image with another JDK keeps it as the default: point java at this one.
  jdk_java="$(dpkg -L "$jdk_package" | grep '/bin/java$' | head -n 1)"
  $SUDO update-alternatives --set java "$jdk_java"
  $SUDO update-alternatives --set javac "$(dirname "$jdk_java")/javac"
else
  log "JDK $JAVA_MAJOR already installed"
fi

SBT_VERSION="$(sed -n 's/^sbt.version=//p' apps/auction/project/build.properties)"
if ! command -v sbt >/dev/null 2>&1 && ! reachable https://repo.scala-sbt.org/scalasbt/debian/; then
  # The launcher from the release fetches the version from build.properties
  # anyway, so installing that same version saves nothing but a download.
  log "Installing sbt $SBT_VERSION from its GitHub release"
  archive="sbt-${SBT_VERSION}.tgz"
  release="https://github.com/sbt/sbt/releases/download/v${SBT_VERSION}"
  curl -fsSL -o "$WORK_DIR/$archive" "$release/$archive"
  echo "$(curl -fsSL "$release/$archive.sha256" | awk '{print $1}')  $WORK_DIR/$archive" | sha256sum -c -
  $SUDO rm -rf /usr/local/sbt
  $SUDO tar -C /usr/local -xzf "$WORK_DIR/$archive"
  $SUDO ln -sf /usr/local/sbt/bin/sbt /usr/local/bin/sbt
elif ! command -v sbt >/dev/null 2>&1; then
  log "Installing sbt"
  if [ ! -f /etc/apt/sources.list.d/sbt.list ]; then
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
  curl -fsSL -o "$WORK_DIR/$archive" "$release/$archive"
  curl -fsSL -o "$WORK_DIR/skillshare-checksums.txt" "$release/checksums.txt"
  (cd "$WORK_DIR" && grep " ${archive}\$" skillshare-checksums.txt | sha256sum -c -)
  $SUDO tar -C /usr/local/bin -xzf "$WORK_DIR/$archive" skillshare
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
