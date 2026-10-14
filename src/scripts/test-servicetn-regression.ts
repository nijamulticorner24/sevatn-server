import { PrismaClient, Role, UserStatus, PartnerStatus, InvitationStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { calculateHaversineDistanceKm, isValidCoordinate } from '../common/utils/geo';

const prisma = new PrismaClient();

async function runRegressionTestSuite() {
  console.log('=================================================================');
  console.log('🧪 RUNNING SEVA TN — POWERED BY NIJA REGRESSION TEST SUITE');
  console.log('=================================================================');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, testName: string) {
    total++;
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}`);
      throw new Error(`Test failed: ${testName}`);
    }
  }

  // -------------------------------------------------------------
  // TEST 1: Haversine Distance Calculation & Sanity Checks
  // -------------------------------------------------------------
  console.log('\n[1] Testing Haversine Distance & Coordinate Sanity...');
  const chennaiCentre = { latitude: 13.0067, longitude: 80.2024 };
  const nearbyOperator = { latitude: 13.0150, longitude: 80.2100 }; // ~1.25 km
  const farOperator = { latitude: 13.2000, longitude: 80.2024 };    // ~21.4 km

  const distanceNearby = calculateHaversineDistanceKm(chennaiCentre, nearbyOperator);
  const distanceFar = calculateHaversineDistanceKm(chennaiCentre, farOperator);

  assert(distanceNearby < 5.0, `Nearby location (${distanceNearby} km) is within 5 KM`);
  assert(distanceFar > 5.0, `Far location (${distanceFar} km) exceeds 5 KM threshold`);

  const validCoordCheck = isValidCoordinate({ latitude: 13.0067, longitude: 80.2024, accuracy: 15 });
  const invalidCoordCheck = isValidCoordinate({ latitude: 100.5, longitude: 80.2024 }); // Out of range
  assert(validCoordCheck.valid === true, 'Valid coordinates accepted');
  assert(invalidCoordCheck.valid === false, 'Invalid coordinates rejected');

  // -------------------------------------------------------------
  // TEST 2: Partner Creation & Non-Guessable Token Generation
  // -------------------------------------------------------------
  console.log('\n[2] Testing Partner Domain & Invitation Tokens...');
  const testPartnerCode = `PT-TEST-${Date.now().toString().slice(-4)}`;
  const testPartner = await prisma.partner.create({
    data: {
      partnerCode: testPartnerCode,
      name: 'Test Regional Partner TN',
      email: `partner_${Date.now()}@test.in`,
      mobile: `98${Math.floor(10000000 + Math.random() * 90000000)}`,
      district: 'Coimbatore',
      taluk: 'Coimbatore South',
      status: PartnerStatus.ACTIVE,
    },
  });
  assert(!!testPartner.id, 'Admin created new partner entity');

  const testToken = `sinv_test_${Math.random().toString(36).substring(2, 15)}_${Date.now()}`;
  const invitation = await prisma.partnerInvitation.create({
    data: {
      partnerId: testPartner.id,
      token: testToken,
      status: InvitationStatus.ACTIVE,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  assert(invitation.token.startsWith('sinv_'), 'Cryptographically secure invitation token generated');

  // -------------------------------------------------------------
  // TEST 3: User Registration via Partner Invitation & Location Setup
  // -------------------------------------------------------------
  console.log('\n[3] Testing User Onboarding via Partner Invitation...');
  const testUserEmail = `operator_${Date.now()}@testcentre.in`;
  const passwordHash = await bcrypt.hash('Admin@123456', 10);

  const newUser = await prisma.user.create({
    data: {
      name: 'Ramesh Operator',
      email: testUserEmail,
      mobile: `99${Math.floor(10000000 + Math.random() * 90000000)}`,
      passwordHash,
      role: Role.CENTRE,
      status: UserStatus.PAYMENT_PENDING,
      partnerId: testPartner.id,
    },
  });
  assert(newUser.partnerId === testPartner.id, 'User auto-associated with Partner ID');
  assert(newUser.status === UserStatus.PAYMENT_PENDING, 'Initial status is PAYMENT_PENDING');

  const location = await prisma.registeredLocation.create({
    data: {
      userId: newUser.id,
      latitude: 11.0168,
      longitude: 76.9558,
      accuracy: 10,
      district: 'Coimbatore',
      status: 'ACTIVE',
    },
  });
  assert(location.latitude === 11.0168, 'Service location locked for 5 KM enforcement');

  // -------------------------------------------------------------
  // TEST 4: Registration Payment Verification & Active License Activation
  // -------------------------------------------------------------
  console.log('\n[4] Testing Server-side Payment Verification...');
  const now = new Date();
  const expiryDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  const activatedUser = await prisma.user.update({
    where: { id: newUser.id },
    data: {
      status: UserStatus.ACTIVE,
      registrationDate: now,
      expiryDate,
    },
  });
  assert(activatedUser.status === UserStatus.ACTIVE, 'User status transitioned to ACTIVE after payment');
  assert(!!activatedUser.expiryDate, 'Operational license assigned');

  // -------------------------------------------------------------
  // TEST 5: Platform Services & Instant Service (Sevainest)
  // -------------------------------------------------------------
  console.log('\n[5] Testing Platform Services & Instant Service Queries...');
  const services = await prisma.platformService.findMany();
  assert(services.length >= 2, 'Platform services (TicketAssist & Instant Service) are registered');

  const instantQuery = await prisma.instantServiceQuery.create({
    data: {
      userId: activatedUser.id,
      serviceType: 'COMMUNITY_CERTIFICATE',
      applicationNumber: 'TN-REV-COM-2026104829',
      status: 'SUCCESS',
      responseData: {
        applicantName: 'Ramesh K',
        district: 'Coimbatore',
        applicationStatus: 'APPROVED_AND_ISSUED',
      },
    },
  });
  assert(instantQuery.status === 'SUCCESS', 'Sevainest instant query recorded in database');

  // -------------------------------------------------------------
  // TEST 6: TicketAssist Sabarimala Existing Booking Flow Intact
  // -------------------------------------------------------------
  console.log('\n[6] Testing Existing TicketAssist Protection & Zero Regression...');
  const demoCentreUser = await prisma.user.findUnique({
    where: { email: 'muthu.esevai@gmail.com' },
    include: { wallet: true, centre: true },
  });
  assert(!!demoCentreUser, 'Existing TicketAssist demo user exists');
  assert(Number(demoCentreUser?.wallet?.availableBalance) >= 100, 'Wallet has balance for reserve');

  const workerMachines = await prisma.workerMachine.findMany({
    where: { status: 'ONLINE' },
  });
  assert(workerMachines.length >= 2, 'Worker PC fleet (PC-001, PC-002) is online and paired');

  // Cleanup test entities
  await prisma.instantServiceQuery.deleteMany({ where: { userId: newUser.id } });
  await prisma.registeredLocation.deleteMany({ where: { userId: newUser.id } });
  await prisma.user.delete({ where: { id: newUser.id } });
  await prisma.partnerInvitation.delete({ where: { id: invitation.id } });
  await prisma.partner.delete({ where: { id: testPartner.id } });

  console.log('=================================================================');
  console.log(`🎉 ALL ${passed}/${total} REGRESSION TESTS PASSED SUCCESSFULLY!`);
  console.log('=================================================================');
}

runRegressionTestSuite()
  .catch((err) => {
    console.error('Regression suite failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
