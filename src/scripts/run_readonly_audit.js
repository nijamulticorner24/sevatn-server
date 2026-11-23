const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runReadOnlyQueries() {
  console.log('=== 1. Active Discovery Schedules ===');
  const schedules = await prisma.$queryRaw`
    SELECT "demandKey", "date", "route", "status", "lastCheckedAt", "lockedBy", "consecutiveErrors"
    FROM "DiscoverySchedule"
    ORDER BY "updatedAt" DESC
    LIMIT 10;
  `;
  console.table(schedules);

  console.log('\n=== 2. Booking Requests Route Values & Statuses ===');
  const bookings = await prisma.$queryRaw`
    SELECT "id", "bookingCode", "requestedDateStr", "route", "status", "createdAt"
    FROM "BookingRequest"
    ORDER BY "createdAt" DESC
    LIMIT 10;
  `;
  console.table(bookings);

  console.log('\n=== 3. Booking Jobs Count and Statuses ===');
  const jobs = await prisma.$queryRaw`
    SELECT "jobType", "status", COUNT(*)::int as count
    FROM "BookingJob"
    GROUP BY "jobType", "status";
  `;
  console.table(jobs);
}

runReadOnlyQueries()
  .catch(err => {
    console.error('Query execution error:', err.message);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
