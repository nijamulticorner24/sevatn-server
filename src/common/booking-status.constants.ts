import { BookingStatus } from '@prisma/client';

/**
 * Authoritative shared definition of claimable open booking request statuses.
 * Used uniformly across:
 * - getDemandDates (Availability discovery)
 * - matchPendingBooking (Cancellation sniper)
 * - claimJob (Worker queue poll fallback)
 * - smartMatcher (Availability event matching)
 * - smartAllocator (Reconciler)
 */
export const CLAIMABLE_OPEN_REQUEST_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.FAST_BOOKING_QUEUED,
  BookingStatus.WATCHING,
  BookingStatus.EXECUTION_QUEUED,
  BookingStatus.WAITING_FOR_ACCOUNT,
  BookingStatus.RETRYABLE_FAILURE,
  BookingStatus.QUEUED,
  BookingStatus.WAITING_FOR_DATE_AVAILABILITY,
  BookingStatus.TEMPORARY_SLOT_LOST,
];

/**
 * Terminal or excluded statuses that can never be executed or claimed.
 */
export const TERMINAL_OR_EXCLUDED_BOOKING_STATUSES: BookingStatus[] = [
  BookingStatus.CANCELLED,
  BookingStatus.COMPLETED,
  BookingStatus.FAILED,
  BookingStatus.EXPIRED,
  BookingStatus.SUCCESS,
  'BOOKING_CONFIRMED' as any,
  BookingStatus.HOLD_INVALID_NOMINEE,
];

/**
 * Terminal booking statuses whose open BookingJobs must be closed atomically.
 */
export const TERMINAL_BOOKING_CLOSURE_STATUSES: BookingStatus[] = [
  BookingStatus.CANCELLED,
  BookingStatus.COMPLETED,
  BookingStatus.FAILED,
  BookingStatus.EXPIRED,
  BookingStatus.SUCCESS,
  'BOOKING_CONFIRMED' as any,
];

/**
 * Job statuses that represent an actively RUNNING execution occupying worker capacity.
 * Explicitly excludes WATCHING, QUEUED, PENDING, COMPLETED, SUCCESS, FAILED, CANCELLED,
 * RETRYABLE_FAILURE, REQUIRES_HUMAN, NEEDS_REVIEW, RECONCILIATION_REQUIRED.
 */
export const ACTIVE_RUNNING_JOB_STATUSES: BookingStatus[] = [
  BookingStatus.EXECUTING,
  BookingStatus.WORKER_ASSIGNED,
  BookingStatus.LOGIN_IN_PROGRESS,
  BookingStatus.BOOKING_IN_PROGRESS,
  BookingStatus.CHECKING_AVAILABILITY,
];

/**
 * In-flight booking request statuses eligible for same-owner or expired-lease takeover
 * (only when no authoritative official reference exists).
 */
export const TAKEOVER_ELIGIBLE_INFLIGHT_STATUSES: BookingStatus[] = [
  BookingStatus.EXECUTING,
  BookingStatus.WORKER_ASSIGNED,
  BookingStatus.CLAIMED,
  BookingStatus.ASSIGNED,
  BookingStatus.MATCHING,
  BookingStatus.LOGIN_IN_PROGRESS,
  BookingStatus.BOOKING_IN_PROGRESS,
  BookingStatus.BOOKING_FLOW_STARTED,
];

/**
 * Extracts a genuine authoritative official booking reference (non-synthetic, non-CartID, >= 5 chars).
 */
export function extractAuthoritativeReference(
  br?: {
    officialBookingReference?: string | null;
    officialReference?: string | null;
    cartId?: string | null;
  } | null,
): string | null {
  if (!br) return null;
  const raw = (br.officialBookingReference || br.officialReference || '').trim();
  if (!raw || raw.length < 5) return null;
  if (raw.startsWith('SAB-2026-') || raw === 'SAB-2026-VERIFIED') return null;
  if (br.cartId && raw === br.cartId.trim()) return null;
  if (/^\d{8,12}$/.test(raw)) return null;
  return raw;
}

export interface JobCapacityEvaluation {
  counts: boolean;
  reason: string;
  leaseRemainingSec?: number;
}

/**
 * Authoritatively evaluates whether a single BookingJob currently counts toward worker active capacity.
 * A job counts ONLY IF:
 * - status is an active RUNNING status (never WATCHING, COMPLETED, SUCCESS, NEEDS_REVIEW, QUEUED, etc.)
 * - leaseExpiresAt is non-null and strictly in the future (unexpired lease)
 * - its associated BookingRequest is NOT in a terminal status and does NOT have an authoritative official reference
 *   (including NEEDS_REVIEW with an official reference)
 * - if workerReportedActiveJobIds is provided, the job is actually present in the worker's live activeJobIds
 */
export function evaluateJobActiveCapacity(
  job: {
    id: string;
    status: BookingStatus | string;
    jobType?: string;
    leaseExpiresAt?: Date | string | null;
    bookingRequest?: {
      id?: string;
      bookingCode?: string;
      status?: BookingStatus | string;
      officialBookingReference?: string | null;
      officialReference?: string | null;
      cartId?: string | null;
      reconciliationStatus?: string | null;
    } | null;
  },
  now: Date = new Date(),
  workerReportedActiveJobIds?: string[],
): JobCapacityEvaluation {
  const status = job.status as BookingStatus;

  if (!ACTIVE_RUNNING_JOB_STATUSES.includes(status)) {
    return { counts: false, reason: `status=${status} (not RUNNING)` };
  }

  const br = job.bookingRequest;
  if (br) {
    const brStatus = br.status as BookingStatus;
    if (TERMINAL_OR_EXCLUDED_BOOKING_STATUSES.includes(brStatus)) {
      return { counts: false, reason: `booking_status=${brStatus} (terminal)` };
    }
    const officialRef = extractAuthoritativeReference(br);
    if (officialRef) {
      const tag = br.reconciliationStatus === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW_WITH_REF' : 'HAS_OFFICIAL_REF';
      return { counts: false, reason: `${tag}(${officialRef})` };
    }
  }

  if (!job.leaseExpiresAt) {
    return { counts: false, reason: 'leaseExpiresAt=null (no active lease)' };
  }

  const leaseMs = new Date(job.leaseExpiresAt).getTime();
  const remainingMs = leaseMs - now.getTime();
  if (Number.isNaN(leaseMs) || remainingMs <= 0) {
    const expiredAgoSec = Number.isNaN(leaseMs) ? 0 : Math.max(0, Math.round(Math.abs(remainingMs) / 1000));
    return { counts: false, reason: `lease_expired(${expiredAgoSec}s ago)` };
  }

  if (Array.isArray(workerReportedActiveJobIds) && !workerReportedActiveJobIds.includes(job.id)) {
    return { counts: false, reason: 'OWN_STALE_LEASE(not in worker activeJobIds)' };
  }

  const leaseRemainingSec = Math.ceil(remainingMs / 1000);
  return {
    counts: true,
    reason: `RUNNING(${status}, leaseExpiresIn=${leaseRemainingSec}s)`,
    leaseRemainingSec,
  };
}

/**
 * Returns current date string in IST (Asia/Kolkata) as YYYY-MM-DD.
 */
export function getTodayISTDateString(): string {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  } catch {
    // Fallback if environment doesn't have timezone db
    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(now.getTime() + istOffsetMs);
    return istDate.toISOString().split('T')[0];
  }
}

/**
 * Returns true if dateStrOrObj is strictly in the past relative to today in IST.
 */
export function isDateInPast(dateStrOrObj: string | Date | null | undefined, todayIST?: string): boolean {
  if (!dateStrOrObj) return false;
  const dateStr = typeof dateStrOrObj === 'string'
    ? dateStrOrObj.trim().split('T')[0]
    : dateStrOrObj.toISOString().split('T')[0];
  const today = todayIST || getTodayISTDateString();
  return dateStr < today;
}

/**
 * Normalizes route into canonical token (PAMBA, ERUMELY, VANDIPERIYAR).
 */
export function normalizeRouteCanonical(route?: string | null): string {
  if (!route) return 'PAMBA';
  const lower = route.toLowerCase();
  if (lower.includes('erumely')) return 'ERUMELY';
  if (lower.includes('vandiperiyar') || lower.includes('sathram')) return 'VANDIPERIYAR';
  if (lower.includes('pamba')) return 'PAMBA';
  return route.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 15) || 'ROUTE';
}

/**
 * Compares candidate route with target route, handling portal formatting variations
 * (e.g. 'Pamba (Regular Footpath Route)' vs 'Pamba - Marakkoottam - 4 Kms').
 */
export function isRouteMatching(candidateRoute?: string | null, targetRoute?: string | null): boolean {
  if (!targetRoute || !targetRoute.trim()) return true;
  if (!candidateRoute || !candidateRoute.trim()) return false;
  const c = candidateRoute.trim().toLowerCase();
  const t = targetRoute.trim().toLowerCase();
  if (c === t) return true;
  const cCanonical = normalizeRouteCanonical(candidateRoute);
  const tCanonical = normalizeRouteCanonical(targetRoute);
  if (cCanonical === tCanonical) return true;
  return c.includes(t) || t.includes(c);
}

/**
 * Unified evaluator for whether a booking request is open and eligible for claiming/scanning.
 */
export function isClaimableOpenRequest(
  request: {
    status: BookingStatus | string;
    nextCheckAt?: Date | string | null;
    nextRetryAt?: Date | string | null;
    requestedDate?: Date | string | null;
    requestedDateStr?: string | null;
  },
  now: Date = new Date(),
): { claimable: boolean; reason?: string } {
  const dateStr =
    request.requestedDateStr ||
    (request.requestedDate instanceof Date
      ? request.requestedDate.toISOString().split('T')[0]
      : String(request.requestedDate || '').split('T')[0]);

  if (dateStr && isDateInPast(dateStr)) {
    return { claimable: false, reason: 'PAST_DATE' };
  }

  if (TERMINAL_OR_EXCLUDED_BOOKING_STATUSES.includes(request.status as BookingStatus)) {
    return { claimable: false, reason: `STATUS_NOT_CLAIMABLE(${request.status})` };
  }

  if (!CLAIMABLE_OPEN_REQUEST_STATUSES.includes(request.status as BookingStatus)) {
    return { claimable: false, reason: `STATUS_NOT_CLAIMABLE(${request.status})` };
  }

  const checkTime = (request as any).nextRetryAt || request.nextCheckAt;
  if (checkTime && new Date(checkTime).getTime() > now.getTime()) {
    return { claimable: false, reason: 'IN_COOLDOWN' };
  }

  return { claimable: true };
}
