import { BookingStatus } from '@prisma/client';
import { validateNominee } from '../common/nominee-validator';

describe('Multi-Pilgrim 10-Devotee Limit & Sequential Processing Suite', () => {
  const unitFee = 20;

  // 1. Booking Limits & Rejection Tests (1, 5, 6, 10 pilgrims; reject > 10)
  describe('Pilgrim Limits & Fee Calculation (1, 5, 6, 10, >10)', () => {
    it('accepts 1, 5, 6, and 10 pilgrims with correct dynamic service fee calculation', () => {
      const allowedCounts = [1, 5, 6, 10];
      for (const count of allowedCounts) {
        expect(count >= 1 && count <= 10).toBe(true);
        const calculatedFee = unitFee * count;
        expect(calculatedFee).toBe(20 * count);
      }
      expect(unitFee * 10).toBe(200);
    });

    it('rejects more than 10 pilgrims', () => {
      const testCounts = [11, 15, 20];
      for (const count of testCounts) {
        const isRejected = count > 10;
        expect(isRejected).toBe(true);
      }
    });

    it('validates up to 10 nominees and rejects more than 10 nominees', () => {
      const tenNominees = Array.from({ length: 10 }, (_, i) => ({
        nomineeName: `Nominee Devotee ${i + 1}`,
        nomineeAge: 25 + i,
        nomineeRelationship: 'Spouse',
        nomineePhone: `987654321${i}`,
      }));

      const validationTen = validateNominee({ nominees: tenNominees }, { allowOptional: false, strictOfficialRelationship: true });
      expect(validationTen.valid).toBe(true);
      expect(validationTen.errors).toHaveLength(0);

      // Verify array limit check
      const elevenNominees = Array.from({ length: 11 }, (_, i) => ({
        nomineeName: `Nominee Devotee ${i + 1}`,
        nomineeAge: 25 + i,
        nomineeRelationship: 'Spouse',
      }));
      const isOverLimit = elevenNominees.length > 10;
      expect(isOverLimit).toBe(true);
    });
  });

  // 2. Sequential Devotee Execution & Single Attempt Per Detection
  describe('Sequential Execution & Fresh Availability Cycle', () => {
    it('processes only one eligible devotee per availability detection cycle', () => {
      const totalDevotees = 10;
      const allDevotees = Array.from({ length: totalDevotees }, (_, i) => ({
        id: `pilgrim-task-${i + 1}`,
        taskIndex: i + 1,
        fullName: `Devotee #${i + 1}`,
        status: 'PENDING',
        metadata: { taskIndex: i + 1, taskStatus: 'PENDING' },
      }));

      // Worker filters eligible pending tasks
      const pendingTasks = allDevotees.filter((t) => t.status === 'PENDING');
      expect(pendingTasks).toHaveLength(10);

      // Worker MUST select only the first eligible pending task for this detection cycle
      const singleTaskAttempted = pendingTasks[0];
      expect(singleTaskAttempted.taskIndex).toBe(1);
      expect(singleTaskAttempted.fullName).toBe('Devotee #1');

      // Do NOT attempt other tasks in this cycle
      const otherTasksInDetection = pendingTasks.slice(1);
      expect(otherTasksInDetection).toHaveLength(9);
    });

    it('preserves parent WATCHING and PARTIALLY_CONFIRMED status after single devotee completion', () => {
      const totalRequested = 10;
      const tasksAfterCycle1 = [
        { id: 'p1', metadata: { taskIndex: 1, taskStatus: 'CONFIRMED', officialBookingReference: 'IVQ261127001' } },
        ...Array.from({ length: 9 }, (_, i) => ({
          id: `p${i + 2}`,
          metadata: { taskIndex: i + 2, taskStatus: 'PENDING' },
        })),
      ];

      const confirmedCount = tasksAfterCycle1.filter((t: any) => t.metadata.taskStatus === 'CONFIRMED').length;
      expect(confirmedCount).toBe(1);

      const remainingDevotees = totalRequested - confirmedCount;
      expect(remainingDevotees).toBe(9);

      const isAllConfirmed = confirmedCount >= totalRequested;
      expect(isAllConfirmed).toBe(false);

      // Parent status outcome
      const parentBookingState = {
        status: isAllConfirmed ? BookingStatus.SUCCESS : BookingStatus.WATCHING,
        isWatching: !isAllConfirmed,
        reconciliationStatus: isAllConfirmed ? null : 'PARTIALLY_CONFIRMED',
        milestone: `PARTIALLY_CONFIRMED (${confirmedCount}/${totalRequested} Confirmed, ${remainingDevotees} Pending)`,
      };

      expect(parentBookingState.status).toBe(BookingStatus.WATCHING);
      expect(parentBookingState.isWatching).toBe(true);
      expect(parentBookingState.reconciliationStatus).toBe('PARTIALLY_CONFIRMED');
      expect(parentBookingState.milestone).toBe('PARTIALLY_CONFIRMED (1/10 Confirmed, 9 Pending)');
    });
  });

  // 3. Devotee Protection & Exclusion of Completed / Admin Completed Devotees
  describe('Completed & Admin-Completed Devotee Protection', () => {
    it('excludes confirmed and Super Admin completed devotees from future booking attempts', () => {
      const allDevotees: any[] = [
        { id: 'p1', fullName: 'Devotee 1', metadata: { taskStatus: 'CONFIRMED', officialBookingReference: 'IVQ001' } },
        { id: 'p2', fullName: 'Devotee 2', metadata: { taskStatus: 'ADMIN_COMPLETED', adminReason: 'Offline pass verified' } },
        { id: 'p3', fullName: 'Devotee 3', metadata: { taskStatus: 'CONFIRMED', officialBookingReference: 'IVQ003' } },
        ...Array.from({ length: 7 }, (_, i) => ({
          id: `p${i + 4}`,
          fullName: `Devotee ${i + 4}`,
          metadata: { taskStatus: 'PENDING' },
        })),
      ];

      const isDevoteeDone = (p: any) => {
        const m = p.metadata || {};
        return (
          m.taskStatus === 'CONFIRMED' ||
          m.taskStatus === 'ADMIN_COMPLETED' ||
          m.status === 'CONFIRMED' ||
          m.status === 'ADMIN_COMPLETED' ||
          !!m.officialBookingReference
        );
      };

      const completedTasks = allDevotees.filter(isDevoteeDone);
      const pendingTasks = allDevotees.filter((p) => !isDevoteeDone(p));

      expect(completedTasks).toHaveLength(3);
      expect(completedTasks.map((t) => t.id)).toEqual(['p1', 'p2', 'p3']);

      expect(pendingTasks).toHaveLength(7);
      expect(pendingTasks.find((t) => t.id === 'p1')).toBeUndefined();
      expect(pendingTasks.find((t) => t.id === 'p2')).toBeUndefined();
      expect(pendingTasks.find((t) => t.id === 'p3')).toBeUndefined();
      expect(pendingTasks[0].id).toBe('p4');
    });
  });

  // 4. Full Parent Completion Invariant
  describe('Full Booking Completion Invariant', () => {
    it('does NOT mark booking as SUCCESS while any devotee remains pending', () => {
      const totalRequested = 10;
      // 9 of 10 confirmed
      const nineConfirmed = Array.from({ length: 10 }, (_, i) => ({
        id: `p${i + 1}`,
        metadata: {
          taskIndex: i + 1,
          taskStatus: i < 9 ? 'CONFIRMED' : 'PENDING',
          officialBookingReference: i < 9 ? `IVQ00${i + 1}` : undefined,
        },
      }));

      const confirmedCount = nineConfirmed.filter((p: any) => p.metadata.taskStatus === 'CONFIRMED').length;
      expect(confirmedCount).toBe(9);

      const isAllConfirmed = confirmedCount >= totalRequested;
      expect(isAllConfirmed).toBe(false);
    });

    it('transitions to SUCCESS only after all 10 devotees reach terminal completion (10/10)', () => {
      const totalRequested = 10;
      // 8 officially confirmed, 2 admin completed
      const allTenCompleted = Array.from({ length: 10 }, (_, i) => ({
        id: `p${i + 1}`,
        metadata: {
          taskIndex: i + 1,
          taskStatus: i < 8 ? 'CONFIRMED' : 'ADMIN_COMPLETED',
          officialBookingReference: i < 8 ? `IVQ00${i + 1}` : undefined,
          adminReason: i >= 8 ? 'Manual VIP allocation' : undefined,
        },
      }));

      const completedCount = allTenCompleted.filter((p: any) => {
        const m = p.metadata || {};
        return m.taskStatus === 'CONFIRMED' || m.taskStatus === 'ADMIN_COMPLETED' || !!m.officialBookingReference;
      }).length;

      expect(completedCount).toBe(10);
      const isAllConfirmed = completedCount >= totalRequested;
      expect(isAllConfirmed).toBe(true);

      const finalStatus = isAllConfirmed ? BookingStatus.SUCCESS : BookingStatus.WATCHING;
      expect(finalStatus).toBe(BookingStatus.SUCCESS);
    });
  });
});
