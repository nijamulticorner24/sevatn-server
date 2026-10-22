#!/usr/bin/env bash
# ==============================================================================
# TicketAssist / ServiceTN — Production Deployment Script
# Target: AWS EC2 Ubuntu (/home/ubuntu/sevatn-server)
# Service: ticketassist-api (PM2 Process)
# Database: PostgreSQL on AWS RDS (servicetn_db)
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${API_DIR}/.." && pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀  TicketAssist / ServiceTN — AWS Production Deployment"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "Directory: ${REPO_ROOT}"

# STEP 1: Inspect Working Tree & Pull Reviewed Code
echo -e "\n📦 [Step 1/8] Verifying Git state and pulling latest release..."
cd "${REPO_ROOT}"

# Check for uncommitted modifications
if [ -n "$(git status --porcelain)" ]; then
  echo "[!] WARNING: Uncommitted tracked or untracked changes detected in working tree:"
  git status --short
  echo "[!] Preserving local changes; refusing to run destructive git reset."
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "[+] Active Branch: ${CURRENT_BRANCH}"
echo "[+] Current Commit: $(git rev-parse --short HEAD)"

# Pull with fast-forward only to avoid unexpected merge conflicts
if git remote get-url origin > /dev/null 2>&1; then
  echo "[+] Fetching latest updates from origin..."
  git pull --ff-only origin "${CURRENT_BRANCH}" || {
    echo "[!] Notice: Fast-forward pull skipped or failed. Proceeding with current checkout."
  }
fi
echo "[+] Release Commit: $(git rev-parse --short HEAD)"

# STEP 2: Install Dependencies Reproducibly
echo -e "\n📚 [Step 2/8] Installing dependencies reproducibly..."
cd "${API_DIR}"
if [ -f "package-lock.json" ]; then
  npm ci --prefer-offline --no-audit
else
  npm install --no-audit
fi

# STEP 3: Generate Prisma Client
echo -e "\n⚙️  [Step 3/8] Generating Prisma Client..."
npx prisma generate --schema=prisma/schema.prisma

# STEP 4: Run Safe Schema Synchronization
echo -e "\n🛡️  [Step 4/8] Running Controlled Schema Synchronization..."
bash "${SCRIPT_DIR}/safe-schema-sync.sh"

# STEP 5: Build NestJS Application
echo -e "\n🏗️  [Step 5/8] Building NestJS application..."
npm run build

# STEP 6: Restart API Process
echo -e "\n🔄 [Step 6/8] Restarting API process (ticketassist-api)..."
if command -v pm2 > /dev/null 2>&1; then
  if pm2 list | grep -q "ticketassist-api"; then
    echo "[+] Restarting existing PM2 process 'ticketassist-api'..."
    pm2 restart ticketassist-api
  else
    echo "[+] Starting PM2 process 'ticketassist-api'..."
    pm2 start dist/main.js --name "ticketassist-api"
  fi
  pm2 save
elif [ -f "/etc/systemd/system/ticketassist-api.service" ]; then
  echo "[+] Restarting systemd service 'ticketassist-api'..."
  sudo systemctl restart ticketassist-api
else
  echo "[!] PM2 or systemd unit not found. Please restart the API process manually:"
  echo "    npm run start:prod"
fi

# STEP 7: Verify API Health and Endpoints
echo -e "\n🔍 [Step 7/8] Verifying API Health and Endpoints..."
sleep 3

API_PORT="${PORT:-4000}"
HEALTH_URL="http://localhost:${API_PORT}/config/public"

echo "[+] Probing API public endpoint: ${HEALTH_URL}"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${HEALTH_URL}" || echo "FAILED")

if [ "${HTTP_CODE}" = "200" ]; then
  echo "[✅] SUCCESS: API returned HTTP 200 on /config/public."
else
  echo "[❌] WARNING: API returned HTTP ${HTTP_CODE} on ${HEALTH_URL}. Check application logs."
fi

# STEP 8: Inspect Logs for Errors
echo -e "\n📋 [Step 8/8] Inspecting recent application logs..."
if command -v pm2 > /dev/null 2>&1 && pm2 list | grep -q "ticketassist-api"; then
  pm2 logs ticketassist-api --lines 20 --nostream
fi

echo -e "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅  Deployment Sequence Completed."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
