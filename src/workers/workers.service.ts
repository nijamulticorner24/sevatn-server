import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  RegisterMachineDto,
  PairMachineDto,
  HeartbeatDto,
  UpdateJobStatusDto,
  ReportJobResultDto,
} from './dto/worker.dto';
import { WorkerStatus, BookingStatus, NotificationChannel, JobType, AccountStatus, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { AccountLockService } from '../availability/account-lock.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';

@Injectable()
export class WorkersService {
  private readonly logger = new Logger(WorkersService.name);

  constructor(
    private prisma: PrismaService,
    private walletService: WalletService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private accountLockService: AccountLockService,
    private smartMatcher: SmartMatcherService,
  ) {}

  /**
   * Worker machine initiates registration and gets a 6-digit pairing code
   */
  async registerMachine(dto: RegisterMachineDto) {
    const pairingCode = `TA-${Math.floor(1000 + Math.random() * 9000)}`;

    const existing = await this.prisma.workerMachine.findUnique({
      where: { machineCode: dto.machineCode },
    });

    let machine;
    if (existing) {
      machine = await this.prisma.workerMachine.update({
        where: { machineCode: dto.machineCode },
        data: {
          machineName: dto.machineName,
          version: dto.version || '1.0.0',
          pairingCode,
          status: WorkerStatus.UNPAIRED,
        },
      });
    } else {
      machine = await this.prisma.workerMachine.create({
        data: {
          machineCode: dto.machineCode,
          machineName: dto.machineName,
          version: dto.version || '1.0.0',
          pairingCode,
          status: WorkerStatus.UNPAIRED,
        },
      });
    }

    return {
      message: 'Worker machine registered. Enter pairing code in Admin portal to activate.',
      machineId: machine.id,
      machineCode: machine.machineCode,
      pairingCode: machine.pairingCode,
    };
  }

  /**
   * Admin enters pairing code to approve machine and generate secure machineToken
   */
  async approvePairing(dto: PairMachineDto, adminUser?: any) {
    const machine = await this.prisma.workerMachine.findUnique({
      where: { pairingCode: dto.pairingCode },
    });

    if (!machine) {
      throw new NotFoundException('Invalid or expired pairing code');
    }

    const machineToken = `wkt_${randomBytes(24).toString('hex')}`;

    const updated = await this.prisma.workerMachine.update({
      where: { id: machine.id },
      data: {
        machineToken,
        status: WorkerStatus.ONLINE,
        active: true,
        desiredState: 'STOPPED', // Pairing approval does NOT automatically start execution
        pairingCode: null,
        lastHeartbeat: new Date(),
      },
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'WORKER_MACHINE_PAIRED',
      entity: 'WorkerMachine',
      entityId: updated.id,
      metadata: { machineCode: updated.machineCode, machineName: updated.machineName },
    });

    return {
      message: 'Worker machine paired successfully',
      machine: updated,
      machineToken,
    };
  }

  /**
   * Super Admin starts / pushes worker execution
   */
  async startWorker(machineId: string, adminUser?: any) {
    const machine = (await this.prisma.workerMachine.findUnique({
      where: { id: machineId },
    })) || (await this.prisma.workerMachine.findUnique({
      where: { machineCode: machineId },
    }));

    if (!machine) {
      throw new NotFoundException('Worker machine not found');
    }

    if (!machine.active || !machine.machineToken) {
      throw new BadRequestException('Cannot start an unpaired worker machine. Complete pairing approval first.');
    }

    const updated = await this.prisma.workerMachine.update({
      where: { id: machine.id },
      data: {
        desiredState: 'RUNNING',
      },
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'WORKER_MACHINE_STARTED',
      entity: 'WorkerMachine',
      entityId: updated.id,
      metadata: { machineCode: updated.machineCode, machineName: updated.machineName },
    });

    return {
      message: `Worker ${updated.machineCode} authorized to execute permitted work`,
      machine: updated,
    };
  }

  /**
   * Super Admin stops worker execution
   */
  async stopWorker(machineId: string, adminUser?: any) {
    const machine = (await this.prisma.workerMachine.findUnique({
      where: { id: machineId },
    })) || (await this.prisma.workerMachine.findUnique({
      where: { machineCode: machineId },
    }));

    if (!machine) {
      throw new NotFoundException('Worker machine not found');
    }

    // If an in-flight job is currently being processed, transition to STOPPING
    // to preserve transaction safety and allow clean conclusion. Otherwise immediately STOPPED.
    const targetState = machine.currentJobId ? 'STOPPING' : 'STOPPED';

    const updated = await this.prisma.workerMachine.update({
      where: { id: machine.id },
      data: {
        desiredState: targetState,
      },
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'WORKER_MACHINE_STOPPED',
      entity: 'WorkerMachine',
      entityId: updated.id,
      metadata: { machineCode: updated.machineCode, machineName: updated.machineName, state: targetState },
    });

    return {
      message: targetState === 'STOPPING'
        ? `Worker ${updated.machineCode} stop requested. Waiting for in-flight job to conclude safely.`
        : `Worker ${updated.machineCode} execution stopped immediately.`,
      machine: updated,
    };
  }

  /**
   * Super Admin resumes worker execution
   */
  async resumeWorker(machineId: string, adminUser?: any) {
    const machine = (await this.prisma.workerMachine.findUnique({
      where: { id: machineId },
    })) || (await this.prisma.workerMachine.findUnique({
      where: { machineCode: machineId },
    }));

    if (!machine) {
      throw new NotFoundException('Worker machine not found');
    }

    if (!machine.active || !machine.machineToken) {
      throw new BadRequestException('Cannot resume an unpaired worker machine. Complete pairing approval first.');
    }

    const updated = await this.prisma.workerMachine.update({
      where: { id: machine.id },
      data: {
        desiredState: 'RUNNING',
      },
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'WORKER_MACHINE_RESUMED',
      entity: 'WorkerMachine',
      entityId: updated.id,
      metadata: { machineCode: updated.machineCode, machineName: updated.machineName },
    });

    return {
      message: `Worker ${updated.machineCode} execution resumed`,
      machine: updated,
    };
  }

  /**
   * Worker machine checks pairing status
   */
  async checkPairingStatus(machineCode: string) {
    const machine = await this.prisma.workerMachine.findUnique({
      where: { machineCode },
    });

    if (!machine) {
      throw new NotFoundException('Machine not found');
    }

    if (machine.active && machine.machineToken) {
      return {
        paired: true,
        machineToken: machine.machineToken,
        status: machine.status,
        desiredState: machine.desiredState || 'STOPPED',
      };
    }

    return {
      paired: false,
      pairingCode: machine.pairingCode,
      status: machine.status,
      desiredState: 'UNPAIRED',
    };
  }

  /**
   * Worker sends periodic heartbeat and reconciles desired administrative state
   */
  async handleHeartbeat(machineId: string, dto: HeartbeatDto) {
    const existingMachine = await this.prisma.workerMachine.findUnique({
      where: { id: machineId },
    });

    const effectiveJobId = dto.activeJobIds && dto.activeJobIds.length > 0
      ? dto.activeJobIds.join(',')
      : (dto.currentJobId ?? null);

    // If machine was in STOPPING state and its in-flight job has concluded, advance to STOPPED
    let nextDesiredState = existingMachine?.desiredState || 'STOPPED';
    if (existingMachine?.desiredState === 'STOPPING' && !effectiveJobId) {
      nextDesiredState = 'STOPPED';
    }

    const updated = await this.prisma.workerMachine.update({
      where: { id: machineId },
      data: {
        status: dto.status as any,
        desiredState: nextDesiredState,
        version: dto.version,
        currentJobId: effectiveJobId,
        cpuUsage: dto.cpuUsage,
        memoryUsage: dto.memoryUsage,
        lastHeartbeat: new Date(),
      },
    });

    return {
      status: 'OK',
      machineId: updated.id,
      desiredState: updated.desiredState,
      executionPermitted: updated.desiredState === 'RUNNING',
      serverTime: new Date(),
    };
  }

  /**
   * Worker claims next eligible job (ACCOUNT_VERIFICATION or BOOKING_EXECUTION)
   * Enforces atomic single-owner claim via Prisma transaction with conditional updates.
   * Strictly enforces Super Admin start/stop state.
   */
  async claimJob(machineId: string) {
    const machine = await this.prisma.workerMachine.findUnique({
      where: { id: machineId },
    });

    if (!machine || !machine.active) {
      throw new UnauthorizedException('Worker machine is not approved or active');
    }

    // Backend enforcement: Reject new job claims if machine is STOPPED or STOPPING
    if (machine.desiredState === 'STOPPED' || machine.desiredState === 'STOPPING') {
      return {
        hasJob: false,
        stopped: true,
        desiredState: machine.desiredState,
        message: `Worker execution is ${machine.desiredState} by administrator`,
      };
    }

    const now = new Date();
    const leaseExpiry = new Date(now.getTime() + 180 * 1000); // 3 min lease

    return await this.prisma.$transaction(async (tx) => {
      // 1. First priority: Account Verification Jobs
      const verificationJob = await tx.bookingJob.findFirst({
        where: {
          jobType: JobType.ACCOUNT_VERIFICATION,
          status: BookingStatus.QUEUED,
        },
        include: {
          account: true,
        },
        orderBy: { createdAt: 'asc' },
      });

      if (verificationJob && verificationJob.account) {
        // Atomic conditional claim: only transitions if still QUEUED
        const claimResult = await tx.bookingJob.updateMany({
          where: {
            id: verificationJob.id,
            status: BookingStatus.QUEUED,
          },
          data: {
            workerId: machineId,
            startedAt: now,
            heartbeatAt: now,
            leaseExpiresAt: leaseExpiry,
            status: BookingStatus.WORKER_ASSIGNED,
            attempt: { increment: 1 },
          },
        });

        if (claimResult.count === 1) {
          return {
            hasJob: true,
            jobType: JobType.ACCOUNT_VERIFICATION,
            job: {
              id: verificationJob.id,
              accountId: verificationJob.accountId,
              username: verificationJob.account.username,
              encryptedPassword: verificationJob.account.encryptedPassword,
              encryptionIv: verificationJob.account.encryptionIv,
              encryptionTag: verificationJob.account.encryptionTag,
              leaseExpiresAt: leaseExpiry,
            },
          };
        }
      }

      // 2. Second priority: Booking Execution Jobs
      const eligibleStatuses = [
        BookingStatus.QUEUED,
        BookingStatus.EXECUTION_QUEUED,
        ((BookingStatus as any).FAST_BOOKING_QUEUED || 'FAST_BOOKING_QUEUED') as any,
      ];

      const bookingJob = await tx.bookingJob.findFirst({
        where: {
          jobType: JobType.BOOKING_EXECUTION,
          OR: [
            { status: { in: eligibleStatuses } },
            {
              status: BookingStatus.WATCHING,
              leaseExpiresAt: { lte: now },
            },
            {
              status: BookingStatus.CHECKING_AVAILABILITY,
              leaseExpiresAt: { lte: now },
            },
          ],
        },
        include: {
          account: true,
          bookingRequest: {
            include: {
              pilgrims: true,
              account: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      if (bookingJob && bookingJob.bookingRequest) {
        const br = bookingJob.bookingRequest;
        const account = bookingJob.account || br.account;

        // Same Account Lock check
        if (account?.id) {
          const lockAcquired = await this.accountLockService.acquireLock(account.id, br.id, machineId);
          if (!lockAcquired) {
            this.logger.warn(`[CLAIM] Booking #${br.bookingCode} account is currently locked by another worker.`);
            return { hasJob: false, message: 'Matching booking account currently locked' };
          }
        }

        // Atomic conditional update ensuring exact single ownership
        const claimResult = await tx.bookingJob.updateMany({
          where: {
            id: bookingJob.id,
            status: bookingJob.status,
            OR: [
              { workerId: null },
              { leaseExpiresAt: { lte: now } },
              { workerId: machineId },
            ],
          },
          data: {
            workerId: machineId,
            startedAt: now,
            heartbeatAt: now,
            leaseExpiresAt: leaseExpiry,
            status: BookingStatus.EXECUTING,
            attempt: { increment: 1 },
          },
        });

        if (claimResult.count === 0) {
          // Lost race to another worker. Release acquired lock and exit safely.
          if (account?.id) {
            await this.accountLockService.releaseLock(account.id, br.id);
          }
          return { hasJob: false, message: 'Job was claimed concurrently by another worker' };
        }

        // Successfully and exclusively claimed! Update booking request and attempt log.
        await tx.bookingRequest.update({
          where: { id: br.id },
          data: {
            assignedMachineId: machineId,
            leaseStartedAt: now,
            leaseExpiresAt: leaseExpiry,
            status: BookingStatus.EXECUTING,
          },
        });

        await tx.bookingAttempt.create({
          data: {
            bookingId: br.id,
            jobId: bookingJob.id,
            machineId,
            status: BookingStatus.EXECUTING,
            attemptNumber: bookingJob.attempt + 1,
            startedAt: now,
          },
        });

        const dateOnlyStr = br.requestedDateStr || (br.requestedDate instanceof Date ? br.requestedDate.toISOString().split('T')[0] : String(br.requestedDate).split('T')[0]);

        return {
          hasJob: true,
          jobType: JobType.BOOKING_EXECUTION,
          job: {
            id: bookingJob.id,
            bookingRequestId: br.id,
            bookingCode: br.bookingCode,
            requestedDate: dateOnlyStr,
            route: br.route,
            pilgrimCount: br.pilgrimCount,
            timeSlot: br.timeSlot,
            selectedTime: br.selectedTime || undefined,
            preferences: br.preferences,
            pilgrims: br.pilgrims,
            account: account
              ? {
                  id: account.id,
                  username: account.username,
                  encryptedPassword: account.encryptedPassword,
                  encryptionIv: account.encryptionIv,
                  encryptionTag: account.encryptionTag,
                }
              : null,
            leaseExpiresAt: leaseExpiry,
          },
        };
      }

      return { hasJob: false, message: 'No pending jobs in queue' };
    });
  }

  /**
   * Worker reports granular Playwright progress update
   */
  async updateJobProgress(jobId: string, machineId: string, dto: { status: BookingStatus; logs?: any; note?: string }) {
    const job = await this.prisma.bookingJob.findUnique({
      where: { id: jobId },
      include: { account: true, bookingRequest: true },
    });

    if (!job) {
      throw new NotFoundException('Job not found');
    }

    if (dto.status === BookingStatus.TEMPORARY_SLOT_LOST && job.bookingRequestId) {
      await this.smartMatcher.returnToPendingOnSlotLoss(job.bookingRequestId, dto.note);
      return { success: true, status: BookingStatus.PENDING };
    }

    const leaseExpiresAt = new Date(Date.now() + 180 * 1000);

    // Update BookingJob only if not already completed
    if (job.status !== BookingStatus.SUCCESS) {
      await this.prisma.bookingJob.update({
        where: { id: jobId },
        data: {
          status: dto.status,
          heartbeatAt: new Date(),
          leaseExpiresAt,
        },
      });
    }

    // If linked to BookingRequest, update it as well only if not already completed/confirmed
    if (job.bookingRequestId) {
      const currentBr = await this.prisma.bookingRequest.findUnique({
        where: { id: job.bookingRequestId },
        select: { status: true, officialReference: true },
      });

      if (currentBr && currentBr.status !== BookingStatus.SUCCESS && !currentBr.officialReference) {
        await this.prisma.bookingRequest.update({
          where: { id: job.bookingRequestId },
          data: {
            status: dto.status,
            lastCheckedAt: new Date(),
            leaseExpiresAt,
            requiresHumanNote: dto.note || undefined,
          },
        });
      }
    }

    // If linked to Account Verification
    if (job.jobType === JobType.ACCOUNT_VERIFICATION && job.accountId) {
      let accountStatus: AccountStatus = AccountStatus.VERIFYING;
      if (dto.status === BookingStatus.LOGIN_SUCCESS) accountStatus = AccountStatus.VERIFIED;
      else if (dto.status === BookingStatus.REQUIRES_HUMAN) accountStatus = AccountStatus.REQUIRES_HUMAN;
      else if (dto.status === BookingStatus.FAILED) accountStatus = AccountStatus.INVALID;

      await this.prisma.bookingAccount.update({
        where: { id: job.accountId },
        data: {
          status: accountStatus,
          verificationNote: dto.note || `Official website: ${dto.status}`,
          lastVerifiedAt: dto.status === BookingStatus.LOGIN_SUCCESS ? new Date() : undefined,
        },
      });
    }

    return { success: true, status: dto.status };
  }

  /**
   * Worker reports completed job (Verified Success)
   */
  async completeJob(jobId: string, machineId: string, dto: { officialReference?: string; confirmationData?: any; note?: string }) {
    const job = await this.prisma.bookingJob.findUnique({
      where: { id: jobId },
      include: { bookingRequest: { include: { user: true } }, account: true },
    });

    if (!job) {
      throw new NotFoundException('Job not found');
    }

    const now = new Date();

    // Idempotency guard: If already completed, return successfully without double capturing
    if (job.status === BookingStatus.SUCCESS) {
      return { success: true, message: 'Job already completed', ref: job.bookingRequest?.officialReference };
    }

    // Ownership guard: Reject stale workers whose lease has transferred to another worker
    if (job.workerId && job.workerId !== machineId && job.leaseExpiresAt && job.leaseExpiresAt > now) {
      throw new ForbiddenException('Machine is not the active owner of this job lease');
    }

    // Release Account Lock
    if (job.accountId || job.bookingRequest?.accountId) {
      await this.accountLockService.releaseLock(job.accountId || job.bookingRequest?.accountId, job.bookingRequestId || undefined);
    }

    // Finalize BookingJob
    await this.prisma.bookingJob.update({
      where: { id: jobId },
      data: {
        status: BookingStatus.SUCCESS,
        completedAt: now,
      },
    });

    if (job.jobType === JobType.ACCOUNT_VERIFICATION && job.accountId) {
      await this.prisma.bookingAccount.update({
        where: { id: job.accountId },
        data: {
          status: AccountStatus.VERIFIED,
          lastVerifiedAt: now,
          verificationNote: 'Account verified successfully via Playwright',
        },
      });
      return { success: true, message: 'Account verified' };
    }

    if (job.bookingRequest) {
      const br = job.bookingRequest;
      const ref = dto.officialReference?.trim();

      // Enforce authoritative external government reference (FIND-004)
      if (!ref || ref.startsWith('SAB-2026-') || ref === 'SAB-2026-VERIFIED' || ref.length < 5) {
        throw new BadRequestException('Authoritative official booking reference is required. Synthetic or mock references are rejected.');
      }

      await this.prisma.bookingRequest.update({
        where: { id: br.id },
        data: {
          status: BookingStatus.SUCCESS,
          officialReference: ref,
          confirmationData: dto.confirmationData || {},
          assignedMachineId: null,
          leaseExpiresAt: null,
          completedAt: now,
        },
      });

      // Capture reserved service fee from centre wallet
      const reserveTx = await this.prisma.walletTransaction.findFirst({
        where: {
          bookingId: br.id,
          type: 'RESERVE',
          status: 'COMPLETED',
        },
      });
      const feeAmount = reserveTx ? Number(reserveTx.amount) : 100;

      await this.walletService.capture({
        userId: br.userId,
        bookingId: br.id,
        amount: feeAmount,
        workerMachineId: machineId,
        idempotencyKey: `cap_${br.id}`,
      });

      // Increment worker metrics
      await this.prisma.workerMachine.update({
        where: { id: machineId },
        data: {
          jobsCompleted: { increment: 1 },
          successCount: { increment: 1 },
          currentJobId: null,
          status: WorkerStatus.ONLINE,
        },
      });

      // Credit partner commission if the booking was performed by a centre under a partner franchise
      if (br.userId) {
        try {
          const bookingUser = await this.prisma.user.findUnique({
            where: { id: br.userId },
            select: { partnerId: true },
          });
          if (bookingUser?.partnerId) {
            const partner = await (this.prisma as any).partner.findUnique({
              where: { id: bookingUser.partnerId },
              select: { id: true, commissionRate: true, commissionPercentage: true },
            });
            if (partner) {
              const commPct = partner.commissionPercentage !== null && partner.commissionPercentage !== undefined
                ? Number(partner.commissionPercentage)
                : (partner.commissionRate ? (Number(partner.commissionRate) / feeAmount) * 100 : 20);
              const commRate = (feeAmount * commPct) / 100;
              await (this.prisma as any).partner.update({
                where: { id: partner.id },
                data: {
                  balance: { increment: new Prisma.Decimal(commRate) },
                },
              });
              this.logger.log(`Credited ₹${commRate} commission (${commPct}% of ₹${feeAmount} service fee) to partner ${partner.id} for completed booking ${br.id}`);
            }
          }
        } catch (commErr: any) {
          this.logger.warn(`Could not credit partner commission: ${commErr.message}`);
        }
      }

      // Notify Centre
      await this.notifications.send({
        userId: br.userId,
        recipient: br.user.email,
        channel: NotificationChannel.IN_APP,
        title: `Official Sabarimala Pass Confirmed: #${br.bookingCode}`,
        body: `Pass Reference: ${ref}. Pilgrims: ${br.pilgrimCount}.`,
        payload: { bookingId: br.id, ref },
      });

      return { success: true, message: 'Booking completed and funds captured' };
    }

    return { success: true };
  }

  /**
   * Worker reports failed or challenge job
   */
  async failJob(jobId: string, machineId: string, dto: { status: BookingStatus; errorCode?: string; errorMessage?: string }) {
    const job = await this.prisma.bookingJob.findUnique({
      where: { id: jobId },
      include: { bookingRequest: true, account: true },
    });

    if (!job) {
      throw new NotFoundException('Job not found');
    }

    // Release Account Lock
    if (job.accountId || job.bookingRequest?.accountId) {
      await this.accountLockService.releaseLock(job.accountId || job.bookingRequest?.accountId, job.bookingRequestId || undefined);
    }

    // Check if slot loss or date unavailable -> transition to PENDING
    if (
      (dto.status === BookingStatus.TEMPORARY_SLOT_LOST ||
        dto.status === BookingStatus.DATE_UNAVAILABLE ||
        dto.status === BookingStatus.PENDING) &&
      job.bookingRequestId
    ) {
      await this.smartMatcher.returnToPendingOnSlotLoss(job.bookingRequestId, dto.errorMessage);
      await this.prisma.workerMachine.update({
        where: { id: machineId },
        data: {
          currentJobId: null,
          status: WorkerStatus.ONLINE,
        },
      });
      return { success: true, message: 'Booking moved to pending for Smart Matcher' };
    }

    await this.prisma.bookingJob.update({
      where: { id: jobId },
      data: {
        status: dto.status,
        errorCode: dto.errorCode,
        errorMessage: dto.errorMessage,
        completedAt: new Date(),
      },
    });

    if (job.jobType === JobType.ACCOUNT_VERIFICATION && job.accountId) {
      const status = dto.status === BookingStatus.REQUIRES_HUMAN ? AccountStatus.REQUIRES_HUMAN : AccountStatus.INVALID;
      await this.prisma.bookingAccount.update({
        where: { id: job.accountId },
        data: {
          status,
          verificationNote: dto.errorMessage || dto.errorCode || 'Verification failed on official website',
        },
      });
    }

    if (job.bookingRequest) {
      const br = job.bookingRequest;

      if (dto.status === BookingStatus.REQUIRES_HUMAN || (dto.status as string) === 'UNKNOWN_RESULT') {
        // Quarantine ambiguous outcome without releasing wallet hold (FIND-002)
        await this.prisma.bookingRequest.update({
          where: { id: br.id },
          data: {
            status: BookingStatus.REQUIRES_HUMAN,
            requiresHumanNote: (dto.status as string) === 'UNKNOWN_RESULT'
              ? `[MANUAL RECONCILIATION] ${dto.errorMessage || 'Official booking unconfirmed after submission. Wallet hold retained for operator verification.'}`
              : (dto.errorMessage || 'Official portal requires verification (CAPTCHA / OTP)'),
          },
        });
      } else {
        await this.prisma.bookingRequest.update({
          where: { id: br.id },
          data: {
            status: dto.status,
            failureReason: dto.errorMessage || dto.errorCode || 'Booking execution failed',
            assignedMachineId: null,
            leaseExpiresAt: null,
          },
        });

        // Release exact reserved hold only on confirmed failures
        const reserveTx = await this.prisma.walletTransaction.findFirst({
          where: {
            bookingId: br.id,
            type: 'RESERVE',
            status: 'COMPLETED',
          },
        });
        const feeAmount = reserveTx ? Number(reserveTx.amount) : 100;

        await this.walletService.release({
          userId: br.userId,
          bookingId: br.id,
          amount: feeAmount,
          reason: dto.errorMessage || 'Booking execution failed',
          idempotencyKey: `rel_${br.id}`,
        });
      }
    }

    await this.prisma.workerMachine.update({
      where: { id: machineId },
      data: {
        failureCount: { increment: 1 },
        currentJobId: null,
        status: WorkerStatus.ONLINE,
      },
    });

    return { success: true };
  }

  /**
   * Renew lease alias
   */
  async renewLease(bookingId: string, machineId: string) {
    const leaseExpiresAt = new Date(Date.now() + 180 * 1000);
    await this.prisma.bookingRequest.updateMany({
      where: { id: bookingId, assignedMachineId: machineId },
      data: { leaseExpiresAt },
    });
    return { leaseExpiresAt };
  }

  /**
   * Update status alias
   */
  async updateJobStatus(bookingId: string, machineId: string, dto: UpdateJobStatusDto) {
    return this.updateJobProgress(bookingId, machineId, {
      status: dto.status as any,
      note: dto.requiresHumanNote || dto.note,
    });
  }

  /**
   * Report result alias
   */
  async reportJobResult(bookingId: string, machineId: string, dto: ReportJobResultDto) {
    if (dto.status === BookingStatus.SUCCESS) {
      return this.completeJob(bookingId, machineId, {
        officialReference: dto.officialReference,
        confirmationData: dto.confirmationData,
      });
    } else {
      return this.failJob(bookingId, machineId, {
        status: dto.status as any,
        errorMessage: dto.failureReason,
      });
    }
  }

  /**
   * List all worker machines for Admin Fleet Dashboard
   */
  async getAllWorkers() {
    const workers = await this.prisma.workerMachine.findMany({
      orderBy: { machineCode: 'asc' },
    });

    const now = new Date();
    return workers.map((w) => {
      const isDead = !w.lastHeartbeat || now.getTime() - new Date(w.lastHeartbeat).getTime() > 45000;
      const isUnpaired = !w.active || !!w.pairingCode || !w.machineToken;
      return {
        ...w,
        status: isDead && w.active ? WorkerStatus.OFFLINE : w.status,
        isDisconnected: isDead,
        pairingStatus: isUnpaired ? 'UNPAIRED' : 'PAIRED',
        desiredState: isUnpaired ? 'UNPAIRED' : (w.desiredState || 'STOPPED'),
        executionPermitted: !isUnpaired && w.desiredState === 'RUNNING',
      };
    });
  }

  /**
   * Auto-recover stale leased jobs where worker disconnected
   */
  async recoverStaleLeasedJobs() {
    const now = new Date();
    const staleJobs = await this.prisma.bookingJob.findMany({
      where: {
        leaseExpiresAt: { lte: now },
        status: { in: [BookingStatus.WORKER_ASSIGNED, BookingStatus.LOGIN_IN_PROGRESS, BookingStatus.BOOKING_IN_PROGRESS] },
      },
    });

    for (const job of staleJobs) {
      this.logger.warn(`Recovering stale job ${job.id} (Lease expired)`);
      await this.prisma.bookingJob.update({
        where: { id: job.id },
        data: {
          workerId: null,
          leaseExpiresAt: null,
          status: BookingStatus.QUEUED,
        },
      });

      if (job.bookingRequestId) {
        await this.prisma.bookingRequest.update({
          where: { id: job.bookingRequestId },
          data: {
            assignedMachineId: null,
            leaseExpiresAt: null,
            status: BookingStatus.QUEUED,
          },
        });
      }
    }

    return { recoveredCount: staleJobs.length };
  }
}
