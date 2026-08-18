#!/usr/bin/env bash
# Nexus Mining Platform — fresh droplet bootstrap (Ubuntu 24.04 LTS)
# Run as root on a NEW droplet:  bash bootstrap.sh
# Deploys branch feature/nicehash-live-loop. Safe to re-run (idempotent-ish).
set -euo pipefail

APP_DIR=/opt/nexus-mining-platform
BRANCH="${BRANCH:-main}"
DOMAIN="${DOMAIN:-}"          # set to e.g. nexus.donelocal.io when DNS is pointed; empty = IP-only
# Secrets are generated server-side when not provided. They land in
# /opt/nexus-mining-platform/backend/.env (chmod 600) — never in the repo.
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -hex 16)}"
API_SECRET="${API_SECRET:-$(openssl rand -hex 24)}"
export DEBIAN_FRONTEND=noninteractive

echo "==> [1/9] system update"
apt-get update -qq && apt-get upgrade -y -qq

echo "==> [2/9] Node.js 20"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
node --version

echo "==> [3/9] PostgreSQL + nginx"
apt-get install -y -qq postgresql nginx

echo "==> [4/9] database + user"
# Idempotent: create the role if missing, otherwise sync its password.
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='nexus'" | grep -q 1 \
  && sudo -u postgres psql -c "ALTER ROLE nexus WITH PASSWORD '${DB_PASSWORD}';" \
  || sudo -u postgres psql -c "CREATE USER nexus WITH PASSWORD '${DB_PASSWORD}';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='nexus_mining'" | grep -q 1 || \
  sudo -u postgres createdb -O nexus nexus_mining

echo "==> [5/9] clone app"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --depth 1 -b "$BRANCH" https://github.com/crypto2retire/nexus-mining-platform.git "$APP_DIR"
else
  cd "$APP_DIR" && git fetch --depth 1 origin "$BRANCH" && git checkout -B "$BRANCH" "origin/$BRANCH"
fi
cd "$APP_DIR"

echo "==> [6/9] deps + frontend build"
npm ci --no-audit --no-fund
(cd frontend && npm ci --no-audit --no-fund && npm run build)

echo "==> [7/9] env + schema"
cat > backend/.env <<EOF
DATABASE_URL=postgresql://nexus:${DB_PASSWORD}@localhost:5432/nexus_mining
NODE_ENV=production
PORT=3000
BASE_RPC_URL=https://mainnet.base.org
PLATFORM_TREASURY_WALLET=0x0000000000000000000000000000000000000000
INTERNAL_SECRET_API_KEY=${API_SECRET}
# NiceHash — fill these in when ready for live orders. LIVE_ORDERS stays 0 (sandbox) until then.
NICEHASH_API_KEY=
NICEHASH_API_SECRET=
NICEHASH_ORG_ID=
NICEHASH_POOL_ID=
NICEHASH_LIVE_ORDERS=0
NICEHASH_MARKET=EU
PRICE_CACHE_TTL_MS=30000
# Local Postgres on this host does not use SSL (would crash otherwise).
DATABASE_SSL=false
# Optional: point at a remote XMRig API to show live mining stats
# (e.g. a Cloudflare quick tunnel to the operator's local miner).
XMRIG_API_URL=
EOF
chmod 600 backend/.env

psql "postgresql://nexus:${DB_PASSWORD}@localhost:5432/nexus_mining" -v ON_ERROR_STOP=1 -f database/init.sql

echo "==> [8/9] systemd unit"
cat > /etc/systemd/system/nexus.service <<'UNIT'
[Unit]
Description=Nexus Mining Platform API
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/nexus-mining-platform/backend
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
EnvironmentFile=/opt/nexus-mining-platform/backend/.env
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now nexus

echo "==> [9/9] nginx reverse proxy"
cat > /etc/nginx/sites-available/nexus <<'NGINX'
server {
    listen 80 default_server;
    server_name _;
    client_max_body_size 5m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/nexus /etc/nginx/sites-enabled/nexus
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> verify"
sleep 2
systemctl status nexus --no-pager | head -8
curl -s "http://127.0.0.1/api/dashboard?wallet=0x1111111111111111111111111111111111111111" | head -c 200
echo
echo "BOOTSTRAP COMPLETE — app on http://<droplet-ip>/"
echo "Generated credentials (DB password, API secret) are in $APP_DIR/backend/.env (owner-only)."
echo "HTTPS: point your domain A record at this IP, then:"
echo "  apt-get install -y certbot python3-certbot-nginx && certbot --nginx -d your.domain"
