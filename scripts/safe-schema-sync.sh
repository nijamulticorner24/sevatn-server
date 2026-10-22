#!/usr/bin/env bash
# ==============================================================================
# TicketAssist / ServiceTN — Hardened Schema Synchronization Script
# Environment: Linux / Ubuntu AWS EC2 (/home/ubuntu/sevatn-server)
# Description: Enforces fail-closed database validation, masks credentials,
#              independently reviews schema diffs, and rejects destructive operations.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${API_DIR}"

echo "================================================================="
echo "  TicketAssist / ServiceTN — Hardened Schema Synchronization"
echo "================================================================="

# 1. Verify .env file exists
if [ ! -f .env ]; then
  echo "[-] FATAL: .env file not found in ${API_DIR}"
  exit 1
fi

# Load environment variables safely
set -a
# shellcheck disable=SC1091
source .env
set +a

# 2. Verify DATABASE_URL exists
if [ -z "${DATABASE_URL:-}" ]; then
  echo "[-] FATAL: DATABASE_URL is not set or empty."
  exit 1
fi

# 3. Mask credentials for all terminal logs
MASKED_DB_URL=$(echo "${DATABASE_URL}" | sed -E 's|://[^:]+:[^@]+@|://***:***@|')
echo "[+] Target Database: ${MASKED_DB_URL}"

# 4. Strict Production Pre-Flight Validation (Fail-Closed)
if [[ "${NODE_ENV:-}" == "production" ]]; then
  # Expected database name check
  EXPECTED_DB="${EXPECTED_DB_NAME:-servicetn_db}"
  if [[ "${DATABASE_URL}" != *"${EXPECTED_DB}"* ]]; then
    echo "[-] FATAL: Production database must be '${EXPECTED_DB}'. Aborting deployment."
    exit 1
  fi

  # Expected hostname check if configured
  if [ -n "${EXPECTED_DB_HOST:-}" ]; then
    if [[ "${DATABASE_URL}" != *"${EXPECTED_DB_HOST}"* ]]; then
      echo "[-] FATAL: Production database host does not match EXPECTED_DB_HOST. Aborting deployment."
      exit 1
    fi
  fi
fi

# 5. Delegate to the hardened TypeScript schema synchronizer
echo "[+] Launching schema synchronizer with independent diff classification..."
exec npx ts-node "${SCRIPT_DIR}/safe-schema-sync.ts" "$@"
