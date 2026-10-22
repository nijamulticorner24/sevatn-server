#!/usr/bin/env bash
# ==============================================================================
# TicketAssist / ServiceTN — Hardened Production Deployment Script
# Target: AWS EC2 Ubuntu (/home/ubuntu/sevatn-server)
# Service: ticketassist-api (PM2 Process)
# Database: PostgreSQL on AWS RDS (servicetn_db)
# Repository: nijamulticorner24/sevatn-server
# Expected Branch: main | Baseline Commit: 77117a25
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${API_DIR}/.." && pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀  TicketAssist / ServiceTN — Production Deployment"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "Root Directory: ${REPO_ROOT}"

# STEP 0: Verify Working Directory Structure
if [ ! -f "${API_DIR}/package.json" ] || [ ! -f "${API_DIR}/prisma/schema.prisma" ]; then
  echo "[-] FATAL: Invalid deployment directory. Expected 'api/package.json' and 'prisma/schema.prisma'."
  exit 1
fi

# STEP 1: Verify Git State & Pull Reviewed Code
echo -e "\n📦 [Step 1/8] Verifying Git state and pulling latest release..."
cd "${REPO_ROOT}"

EXPECTED_BRANCH="${EXPECTED_BRANCH:-main}"
if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
  echo "[+] Active Branch: ${CURRENT_BRANCH}"
  
  if [ "${CURRENT_BRANCH}" != "${EXPECTED_BRANCH}" ]; then
    echo "[-] FATAL: Active Git branch '${CURRENT_BRANCH}' does not match expected branch '${EXPECTED_BRANCH}'."
    echo "    Aborting deployment to avoid deploying unapproved branch."
    exit 1
  fi

  CURRENT_COMMIT=$(git rev-parse --short HEAD)
  echo "[+] Current Working Commit: ${CURRENT_COMMIT}"

  # Check for uncommitted modifications - strictly preserve them
  if [ -n "$(git status --porcelain)" ]; then
    echo "[!] WARNING: Uncommitted tracked or untracked changes detected in working tree:"
    git status --short
    echo "[!] Preserving working tree files. Refusing to run git reset or discard modifications."
  fi

  # Pull with fast-forward only to avoid unexpected merge conflicts
  if git remote get-url origin > /dev/null 2>&1; then
    echo "[+] Fetching latest updates from origin/${EXPECTED_BRANCH}..."
    git pull --ff-only origin "${EXPECTED_BRANCH}" || {
      echo "[!] Notice: Fast-forward pull skipped or failed. Proceeding with current checkout."
    }
  fi
  echo "[+] Deployed Commit: $(git rev-parse --short HEAD)"
else
  echo "[!] Notice: Standalone deployment directory without local .git repository. Skipping git pull."
fi

# STEP 2: Install Dependencies Reproducibly
echo -e "\n📚 [Step 2/8] Installing dependencies reproducibly with existing lockfile..."
cd "${API_DIR}"
if [ ! -f "package-lock.json" ]; then
  echo "[-] FATAL: 'package-lock.json' not found. Cannot perform reproducible npm ci."
  exit 1
fi

npm ci --prefer-offline --no-audit

# STEP 3: Validate and Generate Prisma Client
echo -e "\n⚙️  [Step 3/8] Validating schema and generating Prisma Client..."
npx prisma validate --schema=prisma/schema.prisma
npx prisma generate --schema=prisma/schema.prisma

# STEP 4: Run Guarded Schema Synchronization
echo -e "\n🛡️  [Step 4/8] Running Guarded Schema Synchronization..."
# Runs independent diff review and rejects destructive changes before updating database
npm run schema:sync

# STEP 5: Build NestJS Application
echo -e "\n🏗️  [Step 5/8] Building NestJS application..."
npm run build

# STEP 6: Restart API Process via PM2 (Only reached after prior steps succeed)
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
  echo "[-] FATAL: PM2 process supervisor not found and systemd service not configured."
  echo "    Cannot supervise production API process. Halting."
  exit 1
fi

# STEP 7: Verify API Health and Endpoints (Fail-Closed)
echo -e "\n🔍 [Step 7/8] Verifying API Health and Endpoints..."
sleep 4

API_PORT="${PORT:-4000}"
HEALTH_URL="http://localhost:${API_PORT}/config/public"

echo "[+] Probing API public endpoint: ${HEALTH_URL}"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${HEALTH_URL}" || echo "FAILED")

if [ "${HTTP_CODE}" != "200" ]; then
  echo "[-] FATAL: API health verification FAILED. Received HTTP '${HTTP_CODE}' from ${HEALTH_URL}."
  echo "    Deployment marked as UNHEALTHY. Inspecting recent application logs:"
  if command -v pm2 > /dev/null 2>&1 && pm2 list | grep -q "ticketassist-api"; then
    pm2 logs ticketassist-api --lines 30 --nostream
  fi
  exit 1
fi

echo "[✅] SUCCESS: API returned HTTP 200 on /config/public."

# STEP 8: Inspect Recent Logs for Errors
echo -e "\n📋 [Step 8/8] Inspecting recent application logs for database errors..."
if command -v pm2 > /dev/null 2>&1 && pm2 list | grep -q "ticketassist-api"; then
  pm2 logs ticketassist-api --lines 25 --nostream
fi

echo -e "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅  DEPLOYMENT SUCCESSFUL: All validation, schema sync, and health checks passed."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
