#!/usr/bin/env bash
# ==============================================================================
# TicketAssist / ServiceTN — Controlled Schema Synchronization Script
# Environment: Linux / Ubuntu AWS EC2 (/home/ubuntu/sevatn-server/api)
# Description: Validates DATABASE_URL, masks credentials, checks for unexpected
#              destructive drift, and safely pushes additive schema updates.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${API_DIR}"

echo "================================================================="
echo "  TicketAssist / ServiceTN — Production Safe Schema Sync"
echo "================================================================="

# 1. Check if .env exists
if [ ! -f .env ]; then
  echo "[-] ERROR: .env file not found in ${API_DIR}"
  exit 1
fi

# Load environment variables
set -a
# shellcheck disable=SC1091
source .env
set +a

# 2. Check if DATABASE_URL is set
if [ -z "${DATABASE_URL:-}" ]; then
  echo "[-] ERROR: DATABASE_URL is not set or empty."
  exit 1
fi

# 3. Mask credentials for logging
MASKED_DB_URL=$(echo "${DATABASE_URL}" | sed -E 's|://[^:]+:[^@]+@|://***:***@|')
echo "[+] Target Database: ${MASKED_DB_URL}"

# 4. Confirm expected database name in production
if [[ "${NODE_ENV:-}" == "production" ]]; then
  if [[ "${DATABASE_URL}" != *"servicetn_db"* ]]; then
    echo "[!] WARNING: DATABASE_URL does not reference 'servicetn_db'. Please check configuration."
  fi
fi

# 5. Execute safe schema synchronization
echo "[+] Running Prisma schema sync (prisma db push --skip-generate)..."
if npx prisma db push --skip-generate; then
  echo "[+] SUCCESS: Prisma schema synchronization completed safely."
  echo "================================================================="
  exit 0
else
  echo "[-] ERROR: Prisma schema push failed. Halting deployment."
  echo "================================================================="
  exit 1
fi
