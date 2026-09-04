#!/usr/bin/env bash
set -euo pipefail

DOTNET_CHANNEL="10.0"
DOTNET_DIR="/usr/local/dotnet"
PROTOC_VERSION="33.0"
PROTOC_DIR="/usr/local/protoc33"
LEFTHOOK_VERSION="v1.13.6"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '\n=== %s ===\n' "$1"; }

GO_VERSION="$(awk '/^go [0-9]/ {print $2; exit}' "$REPO_ROOT/apps/identity/go.mod")"
export GOTOOLCHAIN="go${GO_VERSION}"

log "System build dependencies"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  pkg-config libssl-dev unzip curl ca-certificates

if [ ! -x "$DOTNET_DIR/dotnet" ]; then
  log "Installing .NET SDK channel $DOTNET_CHANNEL"
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
  chmod +x /tmp/dotnet-install.sh
  sudo /tmp/dotnet-install.sh --channel "$DOTNET_CHANNEL" --install-dir "$DOTNET_DIR" --no-path
else
  log ".NET SDK already installed"
fi
sudo ln -sf "$DOTNET_DIR/dotnet" /usr/local/bin/dotnet

if ! command -v protoc >/dev/null 2>&1 || \
   [ "$(protoc --version 2>/dev/null | awk '{print $2}')" != "$PROTOC_VERSION" ]; then
  log "Installing protoc $PROTOC_VERSION"
  curl -fsSL -o /tmp/protoc.zip \
    "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-x86_64.zip"
  sudo rm -rf "$PROTOC_DIR"
  sudo mkdir -p "$PROTOC_DIR"
  sudo unzip -oq /tmp/protoc.zip -d "$PROTOC_DIR"
  sudo ln -sf "$PROTOC_DIR/bin/protoc" /usr/local/bin/protoc
else
  log "protoc $PROTOC_VERSION already installed"
fi

if ! command -v just >/dev/null 2>&1; then
  log "Installing just"
  curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | \
    sudo bash -s -- --to /usr/local/bin
else
  log "just already installed"
fi

if ! command -v lefthook >/dev/null 2>&1; then
  log "Installing lefthook $LEFTHOOK_VERSION"
  GOBIN=/tmp/gobin go install "github.com/evilmartians/lefthook@${LEFTHOOK_VERSION}"
  sudo cp /tmp/gobin/lefthook /usr/local/bin/lefthook
else
  log "lefthook already installed"
fi

log "Restoring AppHost"
dotnet restore "$REPO_ROOT/infra/apphost/AppHost.csproj"

log "Installing nats-tester CLI"
pip install --break-system-packages -e "$REPO_ROOT/tools/nats-tester"
if [ -x "$HOME/.local/bin/nats-tester" ]; then
  sudo ln -sf "$HOME/.local/bin/nats-tester" /usr/local/bin/nats-tester
fi

log "Installing Identity toolchain (buf, codegen plugins, golangci-lint)"
(cd "$REPO_ROOT" && just identity-tools)

log "Installing Telegram Bot dependencies"
(cd "$REPO_ROOT" && just telegram-bot-tools)

log "Environment setup complete"
