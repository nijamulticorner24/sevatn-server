import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxService } from '../common/outbox/outbox.service';
import {
  BookingStatus,
  ExecutionStatus,
  FinancialStatus,
  Prisma,
} from '@prisma/client';

export interface TransitionRequest {
  bookingId: string;
  targetStatus: BookingStatus;
  targetExecutionStatus?: ExecutionStatus;
  targetFinancialStatus?: FinancialStatus;
  expectedVersion?: number;
  workerId?: string;
  leaseGeneration?: number;
  milestone?: string;
  note?: string;
  reason?: string;
  operator?: string;
  metadata?: Record<string, any>;
  officialReference?: string;
  cartId?: string;
  officialBookingReference?: string;
  officialReceiptReference?: string;
  portalTransactionReference?: string;
  confirmationEvidence?: any;
  confirmedAt?: Date | string;
  confirmationData?: any;
  failureReason?: string;
  assignedMachineId?: string | null;
  leaseExpiresAt?: Date | null;
  leaseStartedAt?: Date | null;
  force?: boolean;
}

export interface TransitionResult {
  success: boolean;
  booking: any;
  previousStatus: BookingStatus;
  newStatus: BookingStatus;
  version: number;
}

@Injectable()
export class BookingStateMachineService {
  private readonly logger = new Logger(BookingStateMachineService.name);

  // Authoritative lifecycle transition graph
  private readonly VALID_TRANSITIONS: Record<string, BookingStatus[]> = {
    [BookingStatus.NEW]: [BookingStatus.PENDING, BookingStatus.EXECUTION_QUEUED, BookingStatus.CANCELLED],
    [BookingStatus.DRAFT]: [BookingStatus.PENDING, BookingStatus.CANCELLED],
    [BookingStatus.PENDING]: [
      BookingStatus.WAITING_FOR_ACCOUNT,
      BookingStatus.CLAIMED,
      BookingStatus.QUEUED,
      BookingStatus.FAST_BOOKING_QUEUED,
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.EXECUTING,
      BookingStatus.MATCHING,
      BookingStatus.ASSIGNED,
      BookingStatus.WORKER_ASSIGNED,
      BookingStatus.CANCELLED,
      BookingStatus.EXPIRED,
    ],
    [BookingStatus.WAITING_FOR_ACCOUNT]: [
      BookingStatus.PENDING,
      BookingStatus.CLAIMED,
      BookingStatus.QUEUED,
      BookingStatus.EXECUTING,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.QUEUED]: [
      BookingStatus.DISCOVERING,
      BookingStatus.CLAIMED,
      BookingStatus.EXECUTING,
      BookingStatus.WORKER_ASSIGNED,
      BookingStatus.ASSIGNED,
      BookingStatus.PENDING,
      BookingStatus.HOLD_INVALID_NOMINEE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.DISCOVERING]: [
      BookingStatus.QUEUED,
      BookingStatus.CLAIMED,
      BookingStatus.DATE_AVAILABLE,
      BookingStatus.DATE_UNAVAILABLE,
      BookingStatus.ROUTE_UNAVAILABLE,
      BookingStatus.FAILED,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.FAST_BOOKING_QUEUED]: [
      BookingStatus.CLAIMED,
      BookingStatus.EXECUTING,
      BookingStatus.WORKER_ASSIGNED,
      BookingStatus.ASSIGNED,
      BookingStatus.PENDING,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.EXECUTION_QUEUED]: [
      BookingStatus.CLAIMED,
      BookingStatus.EXECUTING,
      BookingStatus.ASSIGNED,
      BookingStatus.WORKER_ASSIGNED,
      BookingStatus.PENDING,
      BookingStatus.CANCELLED,
      BookingStatus.EXPIRED,
    ],
    [BookingStatus.MATCHING]: [
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.WORKER_ASSIGNED,
      BookingStatus.ASSIGNED,
      BookingStatus.PENDING,
      BookingStatus.CLAIMED,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.WORKER_ASSIGNED]: [
      BookingStatus.CLAIMED,
      BookingStatus.EXECUTING,
      BookingStatus.BOOKING_IN_PROGRESS,
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.HOLD_INVALID_NOMINEE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.ASSIGNED]: [
      BookingStatus.CLAIMED,
      BookingStatus.EXECUTING,
      BookingStatus.BOOKING_IN_PROGRESS,
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.HOLD_INVALID_NOMINEE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.CLAIMED]: [
      BookingStatus.LOGIN_SUCCESS,
      BookingStatus.LOGIN_FAILED,
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.EXECUTING,
      BookingStatus.BOOKING_IN_PROGRESS,
      BookingStatus.WORKER_ERROR,
      BookingStatus.FAILED,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.PENDING,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.LOGIN_SUCCESS]: [
      BookingStatus.DATE_VERIFIED,
      BookingStatus.SELECTING_DATE,
      BookingStatus.EXECUTING,
      BookingStatus.BOOKING_IN_PROGRESS,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.DATE_VERIFIED]: [
      BookingStatus.ROUTE_VERIFIED,
      BookingStatus.SELECTING_ROUTE,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.ROUTE_VERIFIED]: [
      BookingStatus.SLOT_VERIFIED,
      BookingStatus.TEMPORARY_SLOT_LOST,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.SLOT_VERIFIED]: [
      BookingStatus.PILGRIMS_VERIFIED,
      BookingStatus.OPENING_PILGRIM_SELECTION,
      BookingStatus.SELECTING_EXISTING_PILGRIMS,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.PILGRIMS_VERIFIED]: [
      BookingStatus.NOMINEE_VERIFIED,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.NOMINEE_VERIFIED]: [
      BookingStatus.RELIEF_VERIFIED,
      BookingStatus.SELECTING_RELIEF_FUND_NO,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.RELIEF_VERIFIED]: [
      BookingStatus.ADDING_TO_WISHLIST,
      BookingStatus.WISHLIST_VERIFIED,
      BookingStatus.WISHLIST_ADDED,
      BookingStatus.PREVIOUS_BOOKING_RESTRICTION,
      BookingStatus.ACCOUNT_PREVIOUS_BOOKING_RESTRICTED,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.ADDING_TO_WISHLIST]: [
      BookingStatus.WISHLIST_VERIFIED,
      BookingStatus.WISHLIST_MISMATCH,
      BookingStatus.PREVIOUS_BOOKING_RESTRICTION,
      BookingStatus.ACCOUNT_PREVIOUS_BOOKING_RESTRICTED,
      BookingStatus.LOADER_TIMEOUT,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.WISHLIST_VERIFIED]: [
      BookingStatus.PROCEEDING_TO_CHECKOUT,
      BookingStatus.CHECKOUT_VERIFIED,
      BookingStatus.PAYMENT_INITIALIZED,
      BookingStatus.ZERO_COST_CONFIRMATION_PENDING,
      BookingStatus.PAYMENT_PENDING,
      BookingStatus.CONFIRMATION_CHECK,
      BookingStatus.WISHLIST_MISMATCH,
      BookingStatus.LOADER_TIMEOUT,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.PROCEEDING_TO_CHECKOUT]: [
      BookingStatus.CHECKOUT_VERIFIED,
      BookingStatus.PAYMENT_INITIALIZED,
      BookingStatus.ZERO_COST_CONFIRMATION_PENDING,
      BookingStatus.PAYMENT_PENDING,
      BookingStatus.LOADER_TIMEOUT,
      BookingStatus.WISHLIST_MISMATCH,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.CHECKOUT_VERIFIED]: [
      BookingStatus.ZERO_COST_CONFIRMATION_PENDING,
      BookingStatus.PAYMENT_PENDING,
      BookingStatus.PAYMENT_INITIALIZED,
      BookingStatus.PAYMENT_SUCCESS,
      BookingStatus.PAYMENT_FAILED,
      BookingStatus.PAYMENT_UNKNOWN,
      BookingStatus.RECONCILIATION_REQUIRED,
      BookingStatus.WISHLIST_MISMATCH,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.WISHLIST_MISMATCH]: [
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.BOOKING_FAILED,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.PREVIOUS_BOOKING_RESTRICTION]: [
      BookingStatus.ACCOUNT_PREVIOUS_BOOKING_RESTRICTED,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.BOOKING_FAILED,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.ACCOUNT_PREVIOUS_BOOKING_RESTRICTED]: [
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.BOOKING_FAILED,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.LOADER_TIMEOUT]: [
      BookingStatus.QUEUED,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.PAYMENT_INITIALIZED]: [
      BookingStatus.ZERO_COST_CONFIRMATION_PENDING,
      BookingStatus.PAYMENT_PENDING,
      BookingStatus.PAYMENT_SUCCESS,
      BookingStatus.PAYMENT_FAILED,
      BookingStatus.PAYMENT_UNKNOWN,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.ZERO_COST_CONFIRMATION_PENDING]: [
      BookingStatus.CONFIRMATION_PENDING,
      BookingStatus.BOOKING_CONFIRMED,
      BookingStatus.SUCCESS,
      BookingStatus.COMPLETED,
      BookingStatus.BOOKING_FAILED,
      BookingStatus.RECONCILIATION_REQUIRED,
      BookingStatus.REQUIRES_HUMAN,
    ],
    [BookingStatus.PAYMENT_PENDING]: [
      BookingStatus.PAYMENT_SUCCESS,
      BookingStatus.PAYMENT_FAILED,
      BookingStatus.PAYMENT_UNKNOWN,
      BookingStatus.RECONCILIATION_REQUIRED,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.PAYMENT_SUCCESS]: [
      BookingStatus.CONFIRMATION_PENDING,
      BookingStatus.BOOKING_CONFIRMED,
      BookingStatus.SUCCESS,
      BookingStatus.COMPLETED,
      BookingStatus.RECONCILIATION_REQUIRED,
    ],
    [BookingStatus.PAYMENT_FAILED]: [
      BookingStatus.BOOKING_FAILED,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.CONFIRMATION_PENDING]: [
      BookingStatus.BOOKING_CONFIRMED,
      BookingStatus.SUCCESS,
      BookingStatus.COMPLETED,
      BookingStatus.BOOKING_FAILED,
      BookingStatus.RECONCILIATION_REQUIRED,
      BookingStatus.REQUIRES_HUMAN,
    ],
    [BookingStatus.BOOKING_CONFIRMED]: [
      BookingStatus.SUCCESS,
      BookingStatus.COMPLETED,
    ],
    [BookingStatus.PAYMENT_UNKNOWN]: [
      BookingStatus.RECONCILIATION_REQUIRED,
      BookingStatus.BOOKING_CONFIRMED,
      BookingStatus.SUCCESS,
      BookingStatus.COMPLETED,
      BookingStatus.BOOKING_FAILED,
      BookingStatus.REQUIRES_HUMAN,
    ],
    [BookingStatus.RECONCILIATION_REQUIRED]: [
      BookingStatus.BOOKING_CONFIRMED,
      BookingStatus.SUCCESS,
      BookingStatus.COMPLETED,
      BookingStatus.BOOKING_FAILED,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.RETRYABLE_FAILURE]: [
      BookingStatus.QUEUED,
      BookingStatus.CLAIMED,
      BookingStatus.FAILED,
      BookingStatus.BOOKING_FAILED,
      BookingStatus.REQUIRES_HUMAN,
    ],
    [BookingStatus.BOOKING_FAILED]: [
      BookingStatus.QUEUED,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.HOLD_INVALID_NOMINEE]: [
      BookingStatus.QUEUED,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.EXECUTING]: [
      BookingStatus.BOOKING_FLOW_STARTED,
      BookingStatus.BOOKING,
      BookingStatus.CONFIRMATION_CHECK,
      BookingStatus.SUCCESS,
      BookingStatus.COMPLETED,
      BookingStatus.UNKNOWN_OUTCOME,
      BookingStatus.UNKNOWN_RESULT,
      BookingStatus.UNKNOWN,
      BookingStatus.TEMPORARY_SLOT_LOST,
      BookingStatus.DATE_UNAVAILABLE,
      BookingStatus.ROUTE_UNAVAILABLE,
      BookingStatus.NO_AVAILABILITY,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.WORKER_ERROR,
      BookingStatus.FAILED,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.RECONCILIATION_REQUIRED,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.BOOKING_IN_PROGRESS]: [
      BookingStatus.CONFIRMATION_CHECK,
      BookingStatus.SUCCESS,
      BookingStatus.COMPLETED,
      BookingStatus.UNKNOWN_OUTCOME,
      BookingStatus.UNKNOWN_RESULT,
      BookingStatus.UNKNOWN,
      BookingStatus.TEMPORARY_SLOT_LOST,
      BookingStatus.WORKER_ERROR,
      BookingStatus.FAILED,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.CONFIRMATION_CHECK]: [
      BookingStatus.SUCCESS,
      BookingStatus.COMPLETED,
      BookingStatus.UNKNOWN_OUTCOME,
      BookingStatus.UNKNOWN_RESULT,
      BookingStatus.UNKNOWN,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.FAILED,
    ],
    [BookingStatus.UNKNOWN_OUTCOME]: [
      BookingStatus.SUCCESS,
      BookingStatus.COMPLETED,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.FAILED,
      BookingStatus.PENDING,
    ],
    [BookingStatus.UNKNOWN_RESULT]: [
      BookingStatus.SUCCESS,
      BookingStatus.COMPLETED,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.FAILED,
      BookingStatus.PENDING,
    ],
    [BookingStatus.UNKNOWN]: [
      BookingStatus.SUCCESS,
      BookingStatus.COMPLETED,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.FAILED,
      BookingStatus.PENDING,
    ],
    [BookingStatus.TEMPORARY_SLOT_LOST]: [
      BookingStatus.PENDING,
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.QUEUED,
      BookingStatus.FAILED,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.REQUIRES_HUMAN]: [
      BookingStatus.PENDING,
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.QUEUED,
      BookingStatus.SUCCESS,
      BookingStatus.COMPLETED,
      BookingStatus.FAILED,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.WORKER_ERROR]: [
      BookingStatus.CANCELLED,
      BookingStatus.PENDING,
      BookingStatus.QUEUED,
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.FAILED,
      BookingStatus.RETRYABLE_FAILURE,
    ],
    [BookingStatus.SITE_ERROR]: [
      BookingStatus.CANCELLED,
      BookingStatus.PENDING,
      BookingStatus.QUEUED,
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.FAILED,
      BookingStatus.RETRYABLE_FAILURE,
    ],
    [BookingStatus.TIMEOUT]: [
      BookingStatus.CANCELLED,
      BookingStatus.PENDING,
      BookingStatus.QUEUED,
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.FAILED,
      BookingStatus.RETRYABLE_FAILURE,
    ],
    [BookingStatus.SITE_UNAVAILABLE]: [
      BookingStatus.CANCELLED,
      BookingStatus.PENDING,
      BookingStatus.QUEUED,
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.FAILED,
      BookingStatus.RETRYABLE_FAILURE,
    ],
    [BookingStatus.LOGIN_FAILED]: [
      BookingStatus.CANCELLED,
      BookingStatus.PENDING,
      BookingStatus.QUEUED,
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.FAILED,
      BookingStatus.RETRYABLE_FAILURE,
    ],
    [BookingStatus.CAPTCHA_REQUIRED]: [
      BookingStatus.CANCELLED,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.FAILED,
    ],
    [BookingStatus.OTP_REQUIRED]: [
      BookingStatus.CANCELLED,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.FAILED,
    ],
    [BookingStatus.NO_AVAILABILITY]: [
      BookingStatus.CANCELLED,
      BookingStatus.WATCHING,
      BookingStatus.CHECKING_AVAILABILITY,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.FAILED,
    ],
    [BookingStatus.DATE_UNAVAILABLE]: [
      BookingStatus.CANCELLED,
      BookingStatus.WATCHING,
      BookingStatus.CHECKING_AVAILABILITY,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.FAILED,
    ],
    [BookingStatus.ROUTE_UNAVAILABLE]: [
      BookingStatus.CANCELLED,
      BookingStatus.WATCHING,
      BookingStatus.CHECKING_AVAILABILITY,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.FAILED,
    ],
    [BookingStatus.DATE_SELECTION_FAILED]: [
      BookingStatus.CANCELLED,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.FAILED,
    ],
    [BookingStatus.DATE_VERIFICATION_FAILED]: [
      BookingStatus.CANCELLED,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.FAILED,
    ],
    [BookingStatus.DATE_AVAILABILITY_TIMEOUT]: [
      BookingStatus.CANCELLED,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.FAILED,
    ],
    [BookingStatus.PILGRIM_SELECTION_FAILED]: [
      BookingStatus.CANCELLED,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.FAILED,
    ],
    [BookingStatus.SUBMIT_FAILED]: [
      BookingStatus.CANCELLED,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.FAILED,
    ],
    [BookingStatus.AVAILABILITY_CHECKING]: [
      BookingStatus.AVAILABILITY_FOUND,
      BookingStatus.NO_AVAILABILITY,
      BookingStatus.WATCHING,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.CHECKING_AVAILABILITY]: [
      BookingStatus.AVAILABILITY_FOUND,
      BookingStatus.NO_AVAILABILITY,
      BookingStatus.WATCHING,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.WATCHING]: [
      BookingStatus.AVAILABILITY_FOUND,
      BookingStatus.NO_AVAILABILITY,
      BookingStatus.CHECKING_AVAILABILITY,
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.WAITING]: [
      BookingStatus.QUEUED,
      BookingStatus.PENDING,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.AVAILABILITY_FOUND]: [
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.QUEUED,
      BookingStatus.CLAIMED,
      BookingStatus.PENDING,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.SUBMITTED]: [
      BookingStatus.PENDING,
      BookingStatus.QUEUED,
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.BROWSER_STARTING]: [
      BookingStatus.OFFICIAL_SITE_OPEN,
      BookingStatus.LOGIN_IN_PROGRESS,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.OFFICIAL_SITE_OPEN]: [
      BookingStatus.LOGIN_IN_PROGRESS,
      BookingStatus.LOGIN_SUCCESS,
      BookingStatus.LOGIN_FAILED,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.OPENING_OFFICIAL_SITE]: [
      BookingStatus.OFFICIAL_SITE_OPEN,
      BookingStatus.LOGIN_IN_PROGRESS,
      BookingStatus.LOGIN_FAILED,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.LOGIN_IN_PROGRESS]: [
      BookingStatus.LOGIN_SUCCESS,
      BookingStatus.LOGIN_FAILED,
      BookingStatus.CAPTCHA_REQUIRED,
      BookingStatus.OTP_REQUIRED,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.BOOKING_FLOW_STARTED]: [
      BookingStatus.OPENING_VIRTUAL_Q,
      BookingStatus.SELECTING_DATE,
      BookingStatus.DATE_VERIFIED,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.OPENING_VIRTUAL_Q]: [
      BookingStatus.SELECTING_DATE,
      BookingStatus.DATE_VERIFIED,
      BookingStatus.WAITING_FOR_DATE_AVAILABILITY,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.WAITING_FOR_DATE_AVAILABILITY]: [
      BookingStatus.DATE_AVAILABLE,
      BookingStatus.SELECTING_DATE,
      BookingStatus.DATE_VERIFIED,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.DATE_AVAILABLE]: [
      BookingStatus.SELECTING_DATE,
      BookingStatus.DATE_VERIFIED,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.SELECTING_DATE]: [
      BookingStatus.VERIFYING_DATE_SELECTION,
      BookingStatus.DATE_SELECTION_VERIFIED,
      BookingStatus.DATE_VERIFIED,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.VERIFYING_DATE_SELECTION]: [
      BookingStatus.DATE_SELECTION_VERIFIED,
      BookingStatus.DATE_VERIFIED,
      BookingStatus.DATE_VERIFICATION_FAILED,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.DATE_SELECTION_VERIFIED]: [
      BookingStatus.SELECTING_ROUTE,
      BookingStatus.ROUTE_VERIFIED,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.SELECTING_ROUTE]: [
      BookingStatus.ROUTE_VERIFIED,
      BookingStatus.SLOT_VERIFIED,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.OPENING_PILGRIM_SELECTION]: [
      BookingStatus.SELECTING_EXISTING_PILGRIMS,
      BookingStatus.PILGRIMS_VERIFIED,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.SELECTING_EXISTING_PILGRIMS]: [
      BookingStatus.PILGRIMS_VERIFIED,
      BookingStatus.SUBMITTING_PILGRIMS,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.SUBMITTING_PILGRIMS]: [
      BookingStatus.PILGRIMS_VERIFIED,
      BookingStatus.NOMINEE_VERIFIED,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.SELECTING_RELIEF_FUND_NO]: [
      BookingStatus.RELIEF_VERIFIED,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.VERIFYING_RESULT]: [
      BookingStatus.WISHLIST_VERIFIED,
      BookingStatus.WISHLIST_ADDED,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.WISHLIST_ADDED]: [
      BookingStatus.WISHLIST_VERIFIED,
      BookingStatus.PROCEEDING_TO_CHECKOUT,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    [BookingStatus.BOOKING]: [
      BookingStatus.CONFIRMATION_CHECK,
      BookingStatus.SUCCESS,
      BookingStatus.COMPLETED,
      BookingStatus.CLAIMED,
      BookingStatus.WORKER_ERROR,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
    ],
    // Terminal states can only be reviewed through explicit admin override
    [BookingStatus.SUCCESS]: [],
    [BookingStatus.COMPLETED]: [],
    [BookingStatus.FAILED]: [BookingStatus.PENDING, BookingStatus.QUEUED, BookingStatus.CANCELLED], // Allow re-try or cancellation by admin
    [BookingStatus.CANCELLED]: [],
    [BookingStatus.EXPIRED]: [BookingStatus.PENDING, BookingStatus.CANCELLED],
  };

  constructor(
    private prisma: PrismaService,
    @Optional() private outboxService?: OutboxService,
  ) {}

  /**
   * Validate if a transition from current to target is legitimate
   */
  canTransition(current: BookingStatus, target: BookingStatus): boolean {
    if (current === target) return true;
    const allowed = this.VALID_TRANSITIONS[current];
    return Array.isArray(allowed) && allowed.includes(target);
  }

  /**
   * Executes an atomic state transition with atomic database Compare-And-Swap (CAS)
   * and transactional outbox persistence within the same database transaction.
   */
  async transition(req: TransitionRequest, prismaTx?: Prisma.TransactionClient): Promise<TransitionResult> {
    const run = async (tx: Prisma.TransactionClient) => {
      const booking = await tx.bookingRequest.findUnique({
        where: { id: req.bookingId },
      });

      if (!booking) {
        throw new NotFoundException(`Booking #${req.bookingId} not found`);
      }

      // Optimistic concurrency check
      if (req.expectedVersion !== undefined && booking.version !== req.expectedVersion) {
        throw new ConflictException(
          `CONCURRENT_MODIFICATION_CONFLICT: Optimistic lock conflict on Booking #${booking.bookingCode}. Expected version ${req.expectedVersion}, but record is at version ${booking.version}`,
        );
      }

      // State transition check (unless forced by admin)
      if (!req.force && !this.canTransition(booking.status, req.targetStatus)) {
        this.logger.warn(
          `Invalid state transition requested for #${booking.bookingCode}: ${booking.status} -> ${req.targetStatus}`,
        );
        throw new BadRequestException(
          `Cannot transition Booking #${booking.bookingCode} from ${booking.status} to ${req.targetStatus}`,
        );
      }

      const now = new Date();
      const casVersion = req.expectedVersion !== undefined ? req.expectedVersion : booking.version;
      const nextVersion = casVersion + 1;

      // Update Booking record data
      const updateData: any = {
        status: req.targetStatus,
        updatedAt: now,
      };

      if (req.targetExecutionStatus) {
        updateData.executionStatus = req.targetExecutionStatus;
      }

      if (req.targetFinancialStatus) {
        updateData.financialStatus = req.targetFinancialStatus;
      }

      // Guard: Never overwrite existing authoritative booking reference on an already confirmed booking
      const currentBooking = booking as any;
      if (
        (currentBooking.officialBookingReference && req.officialBookingReference && currentBooking.officialBookingReference !== req.officialBookingReference) ||
        (currentBooking.officialReference && req.officialReference && currentBooking.officialReference !== req.officialReference && currentBooking.status === BookingStatus.SUCCESS)
      ) {
        this.logger.warn(`[STATE MACHINE] Refusing to overwrite existing authoritative reference ${currentBooking.officialBookingReference || currentBooking.officialReference} with ${req.officialBookingReference || req.officialReference} on #${booking.bookingCode}`);
        throw new ConflictException(`Cannot overwrite authoritative reference ${currentBooking.officialBookingReference || currentBooking.officialReference} on confirmed booking #${booking.bookingCode}`);
      } else if (req.officialBookingReference) {
        updateData.officialBookingReference = req.officialBookingReference;
      }

      if (req.officialReference) {
        updateData.officialReference = req.officialReference;
      }

      if (req.cartId !== undefined) {
        updateData.cartId = req.cartId;
      }

      if (req.officialReceiptReference !== undefined) {
        updateData.officialReceiptReference = req.officialReceiptReference;
      }

      if (req.portalTransactionReference !== undefined) {
        updateData.portalTransactionReference = req.portalTransactionReference;
      }

      if (req.confirmationEvidence !== undefined) {
        updateData.confirmationEvidence = req.confirmationEvidence;
      }

      if (req.confirmationData !== undefined) {
        updateData.confirmationData = req.confirmationData;
      }

      if (req.confirmedAt !== undefined) {
        updateData.confirmedAt = req.confirmedAt instanceof Date ? req.confirmedAt : new Date(req.confirmedAt);
      } else if (req.targetStatus === BookingStatus.SUCCESS && !currentBooking.confirmedAt) {
        updateData.confirmedAt = now;
      }

      if (req.targetStatus === BookingStatus.SUCCESS && !currentBooking.completedAt) {
        updateData.completedAt = now;
      }

      if (req.failureReason) {
        updateData.failureReason = req.failureReason;
      }

      if (req.note) {
        updateData.requiresHumanNote = req.note;
      }

      if (req.milestone) {
        updateData.lastMilestone = req.milestone;
      }

      if (req.assignedMachineId !== undefined) {
        updateData.assignedMachineId = req.assignedMachineId;
      }

      if (req.leaseExpiresAt !== undefined) {
        updateData.leaseExpiresAt = req.leaseExpiresAt;
      }

      if (req.leaseStartedAt !== undefined) {
        updateData.leaseStartedAt = req.leaseStartedAt;
      }

      if (req.targetStatus === BookingStatus.SUCCESS || req.targetStatus === BookingStatus.COMPLETED || req.targetStatus === BookingStatus.BOOKING_CONFIRMED) {
        updateData.completedAt = now;
        updateData.assignedMachineId = null;
        updateData.leaseExpiresAt = null;
      }

      // Real Atomic Database Compare-And-Swap (CAS)
      const updateResult = await tx.bookingRequest.updateMany({
        where: {
          id: req.bookingId,
          version: casVersion,
        },
        data: {
          ...updateData,
          version: { increment: 1 },
        },
      });

      if (updateResult.count === 0) {
        throw new ConflictException(
          `CONCURRENT_MODIFICATION_CONFLICT: Optimistic lock failure on Booking #${booking.bookingCode}. Version ${casVersion} was concurrently modified.`,
        );
      }

      // Record Milestone atomically in same transaction
      if (req.milestone) {
        await tx.bookingMilestone.create({
          data: {
            bookingRequestId: req.bookingId,
            milestone: req.milestone,
            workerId: req.workerId || null,
            metadata: req.metadata || null,
          },
        });
      }

      // Enqueue Outbox Event atomically in same transaction
      if (this.outboxService) {
        try {
          await this.outboxService.enqueueEvent(
            'BookingRequest',
            req.bookingId,
            `BOOKING_${req.targetStatus}`,
            {
              bookingId: req.bookingId,
              bookingCode: booking.bookingCode,
              previousStatus: booking.status,
              status: req.targetStatus,
              version: nextVersion,
              milestone: req.milestone,
              officialReference: req.officialReference,
            },
            tx,
          );
        } catch (outboxErr: any) {
          this.logger.warn(`Failed to enqueue outbox event for booking #${booking.bookingCode}: ${outboxErr.message}`);
        }
      }

      this.logger.log(
        `[STATE MACHINE] #${booking.bookingCode}: ${booking.status} -> ${req.targetStatus} (v${casVersion} -> v${nextVersion})`,
      );

      const updatedBooking = await tx.bookingRequest.findUnique({
        where: { id: req.bookingId },
      });

      return {
        success: true,
        booking: updatedBooking || { ...booking, ...updateData, version: nextVersion },
        previousStatus: booking.status,
        newStatus: req.targetStatus,
        version: nextVersion,
      };
    };

    if (prismaTx) {
      return run(prismaTx);
    } else {
      return this.prisma.$transaction(run);
    }
  }
}
