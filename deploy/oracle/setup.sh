#!/usr/bin/env bash
# Set up (or update) the Nexora gateway on an Ubuntu server, e.g. an Oracle Cloud Always Free VM.
#
#   bash setup.sh                      first run: installs everything; run again any time to update
#   bash setup.sh my.domain.example    use your own domain instead of <ip>.sslip.io
#
# What it does:
#   - Node.js 22, git, Caddy (automatic HTTPS with Let's Encrypt)
#   - clones (or pulls) the repo into /opt/nexora and installs the gateway
#   - runs the gateway as a systemd service on 127.0.0.1:8787 that restarts on failure and on reboot
#   - Caddy serves it at https://<host> and streams replies without buffering
#   - opens ports 80 and 443 in the VM's own firewall (Oracle images block them by default)
#   - adds 1 GB of swap on small VMs
#
# Before running it, put your gateway .env at ~/nexora.env (see deploy/oracle/README.md).
# The gateway's state (gateway/.data) and .env are never overwritten by an update.
set -euo pipefail

REPO="${NEXORA_REPO:-https://github.com/Ved-Malkunaik/NEXORA.git}"
BRANCH="${NEXORA_BRANCH:-main}"
DIR=/opt/nexora
RUN_USER="${SUDO_USER:-$USER}"
ENV_SRC="$HOME/nexora.env"
[ -n "${SUDO_USER:-}" ] && ENV_SRC="$(getent passwd "$SUDO_USER" | cut -d: -f6)/nexora.env"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] && [ -z "${SUDO_USER:-}" ] && die "Run as your normal user (e.g. ubuntu), not as root. The script uses sudo itself."

# ---------- public hostname ----------
PUBLIC_IP="$(curl -fsS4 --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]' || true)"
[[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Could not find this VM's public IP. Does it have one? Pass a hostname instead: bash setup.sh my.domain"
HOST="${1:-${PUBLIC_IP//./-}.sslip.io}"
say "Public address: https://$HOST  (IP $PUBLIC_IP)"

# ---------- packages ----------
say "Installing packages"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent >/dev/null

if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node -v), npm $(npm -v)"

if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy >/dev/null
fi
echo "$(caddy version | cut -d' ' -f1)"

# ---------- swap (1 GB VMs run out of memory during npm install) ----------
if [ "$(free -m | awk '/^Mem:/{print $2}')" -lt 2000 ] && ! swapon --show | grep -q .; then
  say "Adding 1 GB swap"
  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# ---------- code ----------
say "Getting the code ($BRANCH)"
sudo mkdir -p "$DIR" && sudo chown "$RUN_USER:$RUN_USER" "$DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$DIR"
fi
echo "at commit $(git -C "$DIR" log -1 --format='%h %s')"
cd "$DIR/gateway"
npm ci --omit=dev --no-audit --no-fund --loglevel=error

# ---------- config ----------
if [ ! -f .env ]; then
  [ -f "$ENV_SRC" ] || die "No gateway config. Copy your .env to $ENV_SRC first (see deploy/oracle/README.md), then run this again."
  install -m 600 "$ENV_SRC" .env
  echo "installed .env from $ENV_SRC"
fi
for k in CONTRACT_ID GATEWAY_ACCOUNT_ID GATEWAY_PRIVATE_KEY; do
  grep -qE "^$k=.+" .env || die "$k is missing in $DIR/gateway/.env"
done
grep -qE '^NEARAI_API_KEY=.+' .env || echo "warning: NEARAI_API_KEY is not set: replies will be simulated"
grep -qE '^ALLOWED_ORIGINS=.+' .env || echo "warning: ALLOWED_ORIGINS is not set: browsers on your Vercel site will be blocked. Add it once you know the URL (see README)."
mkdir -p .data && chmod 700 .data
# First run only: bring in the state copied from the old gateway (paid notes, spent markers, metering).
DATA_SRC="$(dirname "$ENV_SRC")/nexora-data"
if [ -d "$DATA_SRC" ] && [ -z "$(ls -A .data)" ]; then
  cp "$DATA_SRC"/*.json .data/ && chmod 600 .data/*.json
  echo "imported gateway state from $DATA_SRC: $(ls .data | tr '\n' ' ')"
fi

# ---------- service ----------
say "Gateway service"
sudo tee /etc/systemd/system/nexora-gateway.service >/dev/null <<EOF
[Unit]
Description=Nexora gateway
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$DIR/gateway
Environment=BIND=127.0.0.1
Environment=PORT=8787
ExecStart=/usr/bin/node --env-file=.env src/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable -q nexora-gateway
sudo systemctl restart nexora-gateway

# ---------- HTTPS ----------
say "HTTPS (Caddy)"
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$HOST {
	encode gzip
	reverse_proxy 127.0.0.1:8787 {
		# Chat replies are streamed token by token: never buffer them.
		flush_interval -1
	}
}
EOF
sudo systemctl enable -q caddy
sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy

# ---------- firewall (Oracle Ubuntu images reject everything but SSH in iptables) ----------
say "Firewall: allowing 80 and 443"
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    # Insert before Oracle's catch-all REJECT rule, or append if there is none.
    reject="$(sudo iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}')"
    if [ -n "$reject" ]; then
      sudo iptables -I INPUT "$reject" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    else
      sudo iptables -A INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    fi
  fi
done
sudo netfilter-persistent save >/dev/null 2>&1 || true

# ---------- check ----------
say "Checking"
for i in $(seq 1 20); do
  curl -fsS --max-time 3 http://127.0.0.1:8787/v1/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:8787/v1/health || die "The gateway did not start. See: sudo journalctl -u nexora-gateway -n 50"
echo
if curl -fsS --max-time 60 "https://$HOST/v1/health" >/dev/null 2>&1; then
  echo "HTTPS works: https://$HOST/v1/health"
else
  echo "HTTPS is not answering yet. Usually this means ports 80/443 are not open in the Oracle Cloud"
  echo "security list (README step 3), or the certificate is still being issued: wait a minute and run"
  echo "  curl https://$HOST/v1/health"
fi

cat <<EOF

Done. Gateway URL for Vercel:

    VITE_GATEWAY_URL=https://$HOST

Useful commands:
    sudo systemctl status nexora-gateway        is it running?
    sudo journalctl -u nexora-gateway -f        live logs
    nano $DIR/gateway/.env && sudo systemctl restart nexora-gateway    change settings
    bash $DIR/deploy/oracle/setup.sh            update to the latest code
EOF
