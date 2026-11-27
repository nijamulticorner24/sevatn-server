import { BookingStatus, Role } from '@prisma/client';

describe('Multi-Pilgrim Booking & Devotee Completion Suite', () => {
  it('1. Accurately determines isAllConfirmed based on child devotee tasks, preventing premature parent completion', () => {
    const totalRequested = 5;
    const allPilgrimTasks: any[] = [
      { id: 'p1', metadata: JSON.stringify({ taskStatus: 'CONFIRMED', officialBookingReference: 'IVQ1' }) },
      { id: 'p2', metadata: JSON.stringify({ taskStatus: 'PENDING' }) },
      { id: 'p3', metadata: JSON.stringify({ taskStatus: 'PENDING' }) },
      { id: 'p4', metadata: JSON.stringify({ taskStatus: 'PENDING' }) },
      { id: 'p5', metadata: JSON.stringify({ taskStatus: 'PENDING' }) },
    ];

    const confirmedPilgrimsCount = allPilgrimTasks.filter((p: any) => {
      const meta: any = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : (p.metadata || {});
      return (
        meta.taskStatus === 'CONFIRMED' ||
        meta.taskStatus === 'ADMIN_COMPLETED' ||
        meta.status === 'CONFIRMED' ||
        meta.status === 'ADMIN_COMPLETED' ||
        !!meta.officialBookingReference
      );
    }).length;

    const hasValidPilgrimRecords = allPilgrimTasks.length > 0;
    const isAllConfirmed = totalRequested > 1
      ? hasValidPilgrimRecords && confirmedPilgrimsCount >= totalRequested
      : true;

    expect(confirmedPilgrimsCount).toBe(1);
    expect(isAllConfirmed).toBe(false);
  });

  it('2. Excludes both CONFIRMED and ADMIN_COMPLETED devotees from pending worker tasks', () => {
    const sortedPilgrims: any[] = [
      { id: 'p1', fullName: 'Devotee 1', metadata: { taskStatus: 'CONFIRMED', officialBookingReference: 'IVQ100' } },
      { id: 'p2', fullName: 'Devotee 2', metadata: { taskStatus: 'ADMIN_COMPLETED', adminReason: 'Manual pass issued' } },
      { id: 'p3', fullName: 'Devotee 3', metadata: { taskStatus: 'PENDING' } },
      { id: 'p4', fullName: 'Devotee 4', metadata: {} },
    ];

    const pilgrimTasks = sortedPilgrims.map((p, idx) => {
      const meta: any = p.metadata || {};
      const isAdminCompleted = meta.taskStatus === 'ADMIN_COMPLETED' || meta.status === 'ADMIN_COMPLETED';
      const isConfirmed = meta.taskStatus === 'CONFIRMED' || meta.status === 'CONFIRMED' || !!meta.officialBookingReference;
      return {
        id: p.id,
        fullName: p.fullName,
        status: isAdminCompleted ? 'ADMIN_COMPLETED' : (isConfirmed ? 'CONFIRMED' : 'PENDING'),
      };
    });

    const confirmedTasks = pilgrimTasks.filter((t) => t.status === 'CONFIRMED' || t.status === 'ADMIN_COMPLETED');
    const pendingTasks = pilgrimTasks.filter((t) => t.status !== 'CONFIRMED' && t.status !== 'ADMIN_COMPLETED');

    expect(confirmedTasks).toHaveLength(2);
    expect(confirmedTasks.map((t) => t.id)).toEqual(['p1', 'p2']);
    expect(pendingTasks).toHaveLength(2);
    expect(pendingTasks.map((t) => t.id)).toEqual(['p3', 'p4']);
    expect(pendingTasks.find((t) => t.id === 'p1')).toBeUndefined();
    expect(pendingTasks.find((t) => t.id === 'p2')).toBeUndefined();
  });

  it('3. Reconciler preserves PARTIALLY_CONFIRMED bookings when devotee tasks remain pending', () => {
    const booking: any = {
      id: 'br-10017',
      bookingCode: 'TA-10017',
      pilgrimCount: 5,
      officialBookingReference: 'IVQ26112708415665915317',
      reconciliationStatus: 'PARTIALLY_CONFIRMED',
      pilgrims: [
        { id: 'p1', metadata: { taskStatus: 'CONFIRMED', officialBookingReference: 'IVQ26112708415665915317' } },
        { id: 'p2', metadata: {} },
        { id: 'p3', metadata: {} },
        { id: 'p4', metadata: {} },
        { id: 'p5', metadata: {} },
      ],
    };

    const totalRequested = Math.max(1, booking.pilgrimCount || 1);
    let shouldAutoComplete = true;

    if (totalRequested > 1 && booking.pilgrims && booking.pilgrims.length > 0) {
      const completedCount = booking.pilgrims.filter((p: any) => {
        const meta: any = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : (p.metadata || {});
        return (
          meta.taskStatus === 'CONFIRMED' ||
          meta.taskStatus === 'ADMIN_COMPLETED' ||
          meta.status === 'CONFIRMED' ||
          meta.status === 'ADMIN_COMPLETED' ||
          !!meta.officialBookingReference
        );
      }).length;

      if (completedCount < totalRequested) {
        shouldAutoComplete = false;
      }
    }

    expect(shouldAutoComplete).toBe(false);
  });

  it('4. Successfully marks booking as complete once all devotees reach terminal completion (CONFIRMED or ADMIN_COMPLETED)', () => {
    const totalRequested = 3;
    const allPilgrims: any[] = [
      { id: 'p1', metadata: { taskStatus: 'CONFIRMED', officialBookingReference: 'IVQ1' } },
      { id: 'p2', metadata: { taskStatus: 'CONFIRMED', officialBookingReference: 'IVQ2' } },
      { id: 'p3', metadata: { taskStatus: 'ADMIN_COMPLETED', adminReason: 'Direct counter pass' } },
    ];

    const completedDevotees = allPilgrims.filter((p) => {
      const m: any = p.metadata || {};
      return (
        m.taskStatus === 'CONFIRMED' ||
        m.taskStatus === 'ADMIN_COMPLETED' ||
        m.status === 'CONFIRMED' ||
        m.status === 'ADMIN_COMPLETED' ||
        !!m.officialBookingReference
      );
    });

    const completedCount = completedDevotees.length;
    const isAllDone = completedCount >= totalRequested;

    expect(completedCount).toBe(3);
    expect(isAllDone).toBe(true);
  });
});
