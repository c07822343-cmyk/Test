#!/usr/bin/env bash
# ApexWeb OS installer for macOS and Linux.
#
# Installs (if missing): Git, Node.js, Docker, Obsidian. Then sets up the
# ApexWeb folder and a private .env (random secrets, your NVIDIA keys),
# creates/links your Obsidian vault, starts the services and the desktop app,
# and makes everything start automatically when you log in.
#
#   bash desktop/install/install.sh
# Re-running is safe: existing settings and keys are kept.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/ApexWeb}"
REPO_URL="${REPO_URL:-https://github.com/c07822343-cmyk/Test.git}"
BRANCH="${BRANCH:-claude/vigilant-allen-k8zyr9}"
VAULT_PATH="${VAULT_PATH:-}"
OS="$(uname -s)"

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
secret() { node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; }
get_env() { [ -f "$ENV_FILE" ] && sed -n "s/^[[:space:]]*$1[[:space:]]*=\(.*\)$/\1/p" "$ENV_FILE" | head -n1 || true; }
set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if grep -q "^[[:space:]]*$key[[:space:]]*=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $0 ~ "^[[:space:]]*"k"[[:space:]]*=" {print k"="v; next} {print}' "$ENV_FILE" >"$tmp"
  else
    cat "$ENV_FILE" >"$tmp"; printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  cat "$tmp" >"$ENV_FILE"; rm -f "$tmp"
}

step "Installing prerequisites"
if [ "$OS" = "Darwin" ]; then
  if ! have brew; then
    echo "Homebrew is required: https://brew.sh (install it, then re-run)."; exit 1
  fi
  have git || brew install git
  have node || brew install node
  have docker || brew install --cask docker
  [ -d "/Applications/Obsidian.app" ] || brew install --cask obsidian
else
  if have apt-get; then
    sudo apt-get update -y
    have git || sudo apt-get install -y git
    have node || sudo apt-get install -y nodejs npm
    have docker || { curl -fsSL https://get.docker.com | sudo sh; sudo usermod -aG docker "$USER" || true; }
  else
    for c in git node docker; do have "$c" || { echo "Please install $c with your package manager, then re-run."; exit 1; }; done
  fi
  if ! have obsidian && ! (have flatpak && flatpak info md.obsidian.Obsidian >/dev/null 2>&1); then
    if have flatpak; then flatpak install -y flathub md.obsidian.Obsidian || true
    elif have snap; then sudo snap install obsidian --classic || true
    else echo "Install Obsidian from https://obsidian.md/download (AppImage), then re-run."; fi
  fi
fi
node -e "const [a,b]=process.versions.node.split('.').map(Number); if (a<22||(a===22&&b<18)) { console.error('Node.js 22.18+ is required for tests/scripts; the services run in Docker regardless.'); }"

step "Getting ApexWeb OS"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ -f "$HERE/docker-compose.yml" ]; then INSTALL_DIR="$HERE"; echo "Using this folder: $INSTALL_DIR"
elif [ -f "$INSTALL_DIR/docker-compose.yml" ]; then git -C "$INSTALL_DIR" pull --ff-only
else git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"; fi
cd "$INSTALL_DIR"

step "Configuring (.env)"
ENV_FILE="$INSTALL_DIR/.env"
[ -f "$ENV_FILE" ] || cp .env.example "$ENV_FILE"
chmod 600 "$ENV_FILE"
for k in APEXWEB_API_TOKEN POSTGRES_PASSWORD N8N_WEBHOOK_SECRET N8N_ENCRYPTION_KEY; do
  [ -n "$(get_env "$k")" ] || set_env "$k" "$(secret)"
done
for i in 1 2 3 4; do
  if [ -z "$(get_env "NVIDIA_API_KEY_$i")" ]; then
    read -r -s -p "NVIDIA API key $i (starts with nvapi-; Enter to skip): " key; echo
    [ -z "$key" ] || set_env "NVIDIA_API_KEY_$i" "$key"
  fi
done
[ -n "$VAULT_PATH" ] || VAULT_PATH="$(get_env OBSIDIAN_VAULT_HOST_PATH)"
if [ -z "$VAULT_PATH" ]; then
  default="$HOME/Documents/ApexWeb Vault"
  read -r -p "Obsidian vault folder (Enter for '$default', or path of an existing vault): " answer
  VAULT_PATH="${answer:-$default}"
fi
mkdir -p "$VAULT_PATH"
VAULT_PATH="$(cd "$VAULT_PATH" && pwd)"
set_env OBSIDIAN_VAULT_HOST_PATH "$VAULT_PATH"

step "Starting Docker"
if [ "$OS" = "Darwin" ]; then open -ga Docker || true; fi
for _ in $(seq 1 100); do docker info >/dev/null 2>&1 && break; sleep 3; done
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker (Desktop) once, then re-run."; exit 1; }

step "Starting ApexWeb services (first run builds the image; this can take a few minutes)"
docker compose up -d --build

step "Installing the desktop app"
(cd desktop && npm install --no-audit --no-fund)
ELECTRON="$INSTALL_DIR/desktop/node_modules/.bin/electron"

step "Launching"
nohup "$ELECTRON" "$INSTALL_DIR/desktop" >/dev/null 2>&1 &
if [ "$OS" = "Darwin" ]; then open "obsidian://open?path=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$VAULT_PATH")" || true
else (xdg-open "obsidian://open?path=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$VAULT_PATH")" >/dev/null 2>&1 &) || true; fi

printf '\n\033[32mDone.\033[0m\n'
echo "  ApexWeb OS runs in your menu bar / tray and starts when you log in."
echo "  Dashboard: http://localhost:8080    n8n: http://localhost:5678"
echo "  Obsidian vault: $VAULT_PATH  (if Obsidian asks, choose 'Open folder as vault' and pick it once)"
