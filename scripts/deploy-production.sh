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

# 1. Directory Resolution & Working Tree Setup
# Production repository root is /home/ubuntu/sevatn-server containing
# package.json, package-lock.json, prisma/schema.prisma, and scripts/ directly.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="${API_DIR}"

echo "================================================================="
echo "🚀  TicketAssist / ServiceTN — Production Deployment"
echo "================================================================="
echo "Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "Repository Root: ${REPO_ROOT}"
echo "API Directory  : ${API_DIR}"

# STEP 0: Validate Required Files & Repository Layout
echo -e "\n🔍 [Step 0/10] Validating repository structure and required files..."
if [ ! -f "${REPO_ROOT}/package.json" ]; then
  echo "[-] FATAL: 'package.json' not found in repository root: ${REPO_ROOT}"
  exit 1
fi

if [ ! -f "${REPO_ROOT}/package-lock.json" ]; then
  echo "[-] FATAL: 'package-lock.json' not found in repository root: ${REPO_ROOT}. Cannot perform reproducible npm ci."
  exit 1
fi

if [ ! -f "${REPO_ROOT}/prisma/schema.prisma" ]; then
  echo "[-] FATAL: 'prisma/schema.prisma' not found in repository root: ${REPO_ROOT}."
  exit 1
fi

# Preserve local .env if present; never overwrite or discard
if [ -f "${API_DIR}/.env" ]; then
  echo "[+] Preserving existing .env configuration in ${API_DIR}."
else
  echo "[!] Notice: .env file not found in ${API_DIR}. Ensure production environment variables are exported."
fi

# STEP 1: Verify Git Deployment Safety & Release Synchronization
echo -e "\n📦 [Step 1/10] Verifying Git deployment safety and pulling latest release..."
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

  # Abort on unexpected tracked modifications
  # Preserves .env, dist/, node_modules/, and existing stash; never runs destructive git reset or clean
  TRACKED_DIFF=$(git diff --name-only)
  CACHED_DIFF=$(git diff --cached --name-only)
  if [ -n "${TRACKED_DIFF}" ] || [ -n "${CACHED_DIFF}" ]; then
    echo "[-] FATAL: Unexpected tracked modifications detected in working tree:"
    git status --short --untracked-files=no
    echo "    Preserving .env, dist/, node_modules/, and existing stash. Refusing to run destructive reset or clean."
    echo "    Deployment aborted due to dirty tracked tree."
    exit 1
  fi

  # Informational check for untracked files
  if [ -n "$(git status --porcelain)" ]; then
    echo "[!] Notice: Untracked files present in working tree (e.g. .env, logs). Preserving all files."
  fi

  # Strict Fatal Fetch from Remote Origin
  if git remote get-url origin > /dev/null 2>&1; then
    echo "[+] Fetching latest updates from origin/${EXPECTED_BRANCH}..."
    if ! git fetch origin "${EXPECTED_BRANCH}"; then
      echo "[-] FATAL: 'git fetch origin ${EXPECTED_BRANCH}' failed. Halting deployment."
      exit 1
    fi

    # Strict Fatal Fast-Forward Pull
    echo "[+] Fast-forward pulling latest updates from origin/${EXPECTED_BRANCH}..."
    if ! git pull --ff-only origin "${EXPECTED_BRANCH}"; then
      echo "[-] FATAL: 'git pull --ff-only' failed. Working tree or branch divergence detected. Halting deployment."
      exit 1
    fi
  else
    echo "[!] Notice: Standalone deployment directory without configured remote origin. Skipping network fetch."
  fi

  CURRENT_COMMIT=$(git rev-parse HEAD)
  SHORT_COMMIT=$(git rev-parse --short HEAD)
  echo "[+] Checked-out Commit: ${SHORT_COMMIT} (${CURRENT_COMMIT})"

  # Abort if checked-out commit does not match intended release
  if [ -n "${EXPECTED_COMMIT:-}" ]; then
    if [[ "${CURRENT_COMMIT}" != "${EXPECTED_COMMIT}"* ]] && [[ "${SHORT_COMMIT}" != "${EXPECTED_COMMIT}"* ]]; then
      echo "[-] FATAL: Checked-out commit '${SHORT_COMMIT}' does not match intended release commit '${EXPECTED_COMMIT}'."
      echo "    Aborting deployment to prevent deploying unapproved revision."
      exit 1
    fi
    echo "[+] Verified intended release commit: ${SHORT_COMMIT}"
  fi
else
  echo "[!] Notice: Standalone deployment directory without local .git repository. Skipping git operations."
fi

# STEP 2: Install Dependencies Reproducibly
echo -e "\n📚 [Step 2/10] Installing dependencies reproducibly with existing lockfile..."
cd "${API_DIR}"
if [ ! -f "package-lock.json" ]; then
  echo "[-] FATAL: 'package-lock.json' not found in ${API_DIR}. Cannot perform reproducible npm ci."
  exit 1
fi

npm ci --prefer-offline --no-audit

# STEP 3: Validate Prisma Schema
echo -e "\n⚙️  [Step 3/10] Validating Prisma schema..."
cd "${API_DIR}"
npx prisma validate --schema=prisma/schema.prisma

# STEP 4: Generate Prisma Client
echo -e "\n🔧 [Step 4/10] Generating Prisma Client..."
cd "${API_DIR}"
npx prisma generate --schema=prisma/schema.prisma

# STEP 5: Build NestJS Application (Before considering database mutation)
echo -e "\n🏗️  [Step 5/10] Building NestJS application before considering schema mutation..."
cd "${API_DIR}"
npm run build

# STEP 6: Run Schema Synchronizer in Dry-Run Mode (Produces reviewable SQL diff)
echo -e "\n🔎 [Step 6/10] Running Guarded Schema Synchronizer in DRY-RUN mode..."
cd "${API_DIR}"
npm run schema:dry-run

# STEP 7: Explicit Production Approval Gate for Live Schema Mutation
echo -e "\n🛡️  [Step 7/10] Evaluating production approval for schema mutation..."
APPROVE_SYNC="${CONFIRM_PRODUCTION_SCHEMA_SYNC:-}"
for arg in "$@"; do
  if [ "$arg" == "--approve-schema-sync" ] || [ "$arg" == "--confirm" ]; then
    APPROVE_SYNC="yes"
  fi
done

if [ "${APPROVE_SYNC}" == "yes" ]; then
  echo "[+] Explicit production approval verified. Applying validated additive schema changes..."
  cd "${API_DIR}"
  CONFIRM_PRODUCTION_SCHEMA_SYNC=yes npm run schema:sync
else
  echo "[-] FATAL: Production schema changes require separate explicit approval."
  echo "    Set CONFIRM_PRODUCTION_SCHEMA_SYNC=yes or pass --approve-schema-sync to apply."
  echo "    Aborting deployment before live database mutation. PM2 was NOT restarted."
  exit 1
fi

# STEP 8: Restart API Process via PM2 (Only reached after approved schema sync & build)
echo -e "\n🔄 [Step 8/10] Restarting API process (ticketassist-api)..."
cd "${API_DIR}"
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

# STEP 9: Verify API Health and Endpoints (Fail-Closed)
echo -e "\n🔍 [Step 9/10] Verifying API Health and Endpoints..."
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

# STEP 10: Inspect Recent Application Logs
echo -e "\n📋 [Step 10/10] Inspecting recent application logs for errors..."
if command -v pm2 > /dev/null 2>&1 && pm2 list | grep -q "ticketassist-api"; then
  pm2 logs ticketassist-api --lines 25 --nostream
fi

echo -e "\n================================================================="
echo "✅  DEPLOYMENT SUCCESSFUL: All validation, build, schema sync, and health checks passed."
echo "================================================================="
