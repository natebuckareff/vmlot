#!/usr/bin/env bash
set -euo pipefail

BIN_PATH="${VMLOT_BIN_PATH:-/usr/local/bin/vmlot}"
BINARY_URL="${VMLOT_BINARY_URL:-https://github.com/natebuckareff/vmlot/releases/latest/download/vmlot-linux-x64}"
SERVICE_PATH="${VMLOT_SERVICE_PATH:-/etc/systemd/system/vmlot.service}"
SYSUSERS_PATH="${VMLOT_SYSUSERS_PATH:-/etc/sysusers.d/vmlot.conf}"
CONFIG_DIR="${VMLOT_CONFIG_DIR:-/etc/vmlot}"
TEMP_BINARY=""

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "error: run as root, for example: curl -fsSL ... | sudo bash" >&2
    exit 1
  fi
}

require_command() {
  local command_name="$1"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "error: required command not found: ${command_name}" >&2
    exit 1
  fi
}

download_binary() {
  local destination="$1"

  if command -v curl >/dev/null 2>&1; then
    curl -fL "${BINARY_URL}" -o "${destination}"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "${destination}" "${BINARY_URL}"
  else
    echo "error: install curl or wget" >&2
    exit 1
  fi

  chmod 0755 "${destination}"
}

write_sysusers_file() {
  install -d -m 0755 "$(dirname "${SYSUSERS_PATH}")"
  cat >"${SYSUSERS_PATH}" <<EOF
u vmlot - "vmlot server" /var/lib/vmlot /usr/sbin/nologin
EOF
  chmod 0644 "${SYSUSERS_PATH}"
}

write_service_file() {
  install -d -m 0755 "$(dirname "${SERVICE_PATH}")"
  cat >"${SERVICE_PATH}" <<EOF
[Unit]
Description=vmlot server
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=vmlot
Group=vmlot
SupplementaryGroups=libvirt
Environment=VMLOT_CONFIG_DIR=${CONFIG_DIR}
StateDirectory=vmlot
StateDirectoryMode=0755
ExecStart=${BIN_PATH} run --data-dir /var/lib/vmlot --host 0.0.0.0
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "${SERVICE_PATH}"
}

write_config_example() {
  install -d -m 0750 -o root -g vmlot "${CONFIG_DIR}"

  if [[ ! -f "${CONFIG_DIR}/config.json.example" ]]; then
    cat >"${CONFIG_DIR}/config.json.example" <<'EOF'
{
  "tailscale": {
    "oauthClientId": "your-oauth-client-id",
    "oauthClientSecret": "your-oauth-client-secret",
    "authKeyExpirySeconds": 3600,
    "tags": ["tag:vmlot"],
    "tailnet": "-"
  }
}
EOF
    chown root:vmlot "${CONFIG_DIR}/config.json.example"
    chmod 0640 "${CONFIG_DIR}/config.json.example"
  fi

  if [[ -f "${CONFIG_DIR}/config.json" ]]; then
    chown root:vmlot "${CONFIG_DIR}/config.json"
    chmod 0640 "${CONFIG_DIR}/config.json"
  fi
}

main() {
  require_root
  require_command install
  require_command systemctl
  require_command systemd-sysusers

  TEMP_BINARY="$(mktemp)"
  trap 'rm -f "${TEMP_BINARY}"' EXIT

  download_binary "${TEMP_BINARY}"
  install -D -m 0755 "${TEMP_BINARY}" "${BIN_PATH}"

  write_sysusers_file
  systemd-sysusers "${SYSUSERS_PATH}"

  write_config_example
  install -d -m 0755 -o vmlot -g vmlot /var/lib/vmlot

  write_service_file
  systemctl daemon-reload

  echo "vmlot installed."
  echo "Binary: ${BIN_PATH}"
  echo "Service: ${SERVICE_PATH}"
  echo "Config example: ${CONFIG_DIR}/config.json.example"
  echo "Config path: ${CONFIG_DIR}/config.json"
  echo
  echo "The service has not been started yet."
  echo "Create ${CONFIG_DIR}/config.json then run:"
  echo ""
  echo "  sudo systemctl enable --now vmlot.service"
  echo ""
}

main "$@"
