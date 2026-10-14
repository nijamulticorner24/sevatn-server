import { PrismaClient, Role, UserStatus, CentreStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { CentresService } from '../centres/centres.service';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

async function runSecurityAndFunctionalityTests() {
  console.log('================================================================');
  console.log('🧪 RUNNING TICKETASSIST ADMIN-ONLY CENTRE REGISTRATION TEST SUITE');
  console.log('================================================================\n');

  const prisma = new PrismaClient() as any;
  const prismaService = prisma as PrismaService;
  const jwtService = new JwtService({ secret: process.env.JWT_SECRET || 'ticketassist-dev-secret-2026' });
  const auditService = new AuditService(prismaService);
  const eventsGateway = { emitBookingStatus: () => {}, broadcastToAdmins: () => {}, emitToUser: () => {} } as any;
  const authService = new AuthService(prismaService, jwtService, auditService, eventsGateway);
  const centresService = new CentresService(prismaService, auditService);

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName} ${detail ? `- ${detail}` : ''}`);
      throw new Error(`Test failed: ${testName}`);
    }
  }

  try {
    // -------------------------------------------------------------
    // Test 1: Anonymous public registration is strictly disabled
    // -------------------------------------------------------------
    let test1Passed = false;
    try {
      await authService.registerCentre();
    } catch (err: any) {
      test1Passed = err.status === 403 || err.message.includes('disabled');
    }
    assert(test1Passed, 'Test 1: Anonymous /auth/register is rejected with 403 Forbidden');

    // -------------------------------------------------------------
    // Fetch Admin & Centre Users
    // -------------------------------------------------------------
    const adminUser = await prisma.user.findFirst({
      where: { role: Role.SUPER_ADMIN },
    });
    const existingCentreUser = await prisma.user.findFirst({
      where: { role: Role.CENTRE, email: 'muthu.esevai@gmail.com' },
    });

    assert(!!adminUser, 'Setup: Admin user found in database');
    assert(!!existingCentreUser, 'Setup: Existing centre user found in database');

    // -------------------------------------------------------------
    // Test 2: Existing centre accounts remain intact (mustChangePassword = false)
    // -------------------------------------------------------------
    assert(
      existingCentreUser.mustChangePassword === false,
      'Test 2: Existing Centre accounts preserved without forced reset',
    );

    // -------------------------------------------------------------
    // Test 3: Admin creates a new Centre
    // -------------------------------------------------------------
    const testEmail = `centre.test.${Date.now()}@example.com`;
    const testMobile = `9${Math.floor(100000000 + Math.random() * 900000000)}`;
    const testCentreCode = `TN-TST-${Date.now().toString().slice(-4)}`;

    const createResult = await centresService.createCentre(adminUser, {
      centreName: 'Sri Balaji Online CSC Point',
      name: 'Balaji Subramanian',
      email: testEmail,
      mobile: testMobile,
      district: 'Tiruchirappalli',
      taluk: 'Srirangam',
      address: '10, North Car Street, Srirangam',
      pincode: '620006',
      centreCode: testCentreCode,
      status: CentreStatus.ACTIVE,
      validityDays: 45,
    });

    assert(!!createResult.centre, 'Test 3a: Centre entity successfully created');
    assert(createResult.user.role === Role.CENTRE, 'Test 3b: Created user role forced strictly to CENTRE');
    assert(createResult.user.mustChangePassword === true, 'Test 3c: Created user requires first-login password change');
    assert(!!createResult.temporaryPassword, 'Test 3d: Temporary password generated for admin handoff');
    assert(createResult.centre.centreCode === testCentreCode, 'Test 3e: Custom Centre Code correctly set');

    // Verify wallet created transactionally
    const wallet = await prisma.wallet.findUnique({
      where: { userId: createResult.user.id },
    });
    assert(!!wallet, 'Test 3f: Wallet initialized transactionally for new centre');

    // Verify audit log
    const auditLog = await prisma.auditLog.findFirst({
      where: { entityId: createResult.centre.id, action: 'CENTRE_CREATED' },
    });
    assert(!!auditLog, 'Test 3g: CENTRE_CREATED audit log recorded');

    // -------------------------------------------------------------
    // Test 4: Duplicate Email Prevention
    // -------------------------------------------------------------
    let duplicateEmailPassed = false;
    try {
      await centresService.createCentre(adminUser, {
        centreName: 'Duplicate Email Centre',
        name: 'Another Person',
        email: testEmail,
        mobile: '9111122223',
        district: 'Chennai',
        taluk: 'Egmore',
      });
    } catch (err: any) {
      duplicateEmailPassed = err.status === 409 || err.message.includes('already exists');
    }
    assert(duplicateEmailPassed, 'Test 4: Duplicate email rejected with 409 Conflict');

    // -------------------------------------------------------------
    // Test 5: Duplicate Centre Code Prevention
    // -------------------------------------------------------------
    let duplicateCodePassed = false;
    try {
      await centresService.createCentre(adminUser, {
        centreName: 'Duplicate Code Centre',
        name: 'Another Person',
        email: `unique.${Date.now()}@example.com`,
        mobile: '9333344445',
        district: 'Salem',
        taluk: 'Salem South',
        centreCode: testCentreCode,
      });
    } catch (err: any) {
      duplicateCodePassed = err.status === 409 || err.message.includes('already in use') || err.message.includes('already assigned');
    }
    assert(duplicateCodePassed, 'Test 5: Duplicate Centre Code rejected with 409 Conflict');

    // -------------------------------------------------------------
    // Test 6: First Login with Temporary Password
    // -------------------------------------------------------------
    const loginResult = await authService.login({
      identifier: testEmail,
      password: createResult.temporaryPassword,
    });

    assert(!!loginResult.token, 'Test 6a: JWT token issued on temporary password login');
    assert(loginResult.mustChangePassword === true, 'Test 6b: Login response marks mustChangePassword = true');

    // -------------------------------------------------------------
    // Test 7: First Login Password Change
    // -------------------------------------------------------------
    const newPermanentPassword = 'SecurePermanent@2026';
    const changePassResult = await authService.changePassword(createResult.user.id, {
      newPassword: newPermanentPassword,
    });

    assert(changePassResult.mustChangePassword === false, 'Test 7a: Password change cleared mustChangePassword flag');

    // Verify subsequent login with new password
    const loginWithNewPass = await authService.login({
      identifier: testEmail,
      password: newPermanentPassword,
    });
    assert(!!loginWithNewPass.token, 'Test 7b: Login with new permanent password successful');
    assert(loginWithNewPass.mustChangePassword === false, 'Test 7c: Subsequent login reports mustChangePassword = false');

    // -------------------------------------------------------------
    // Test 8: Admin Suspend and Activate Lifecycle
    // -------------------------------------------------------------
    const suspendResult = await centresService.suspendCentre(adminUser, createResult.centre.id);
    assert(suspendResult.centre.status === CentreStatus.SUSPENDED, 'Test 8a: Admin successfully suspended centre');

    let suspendedLoginBlocked = false;
    try {
      await authService.login({
        identifier: testEmail,
        password: newPermanentPassword,
      });
    } catch (err: any) {
      suspendedLoginBlocked = err.status === 403 || err.message.includes('suspended');
    }
    assert(suspendedLoginBlocked, 'Test 8b: Suspended centre operator blocked from sign-in');

    const activateResult = await centresService.activateCentre(adminUser, createResult.centre.id);
    assert(activateResult.centre.status === CentreStatus.ACTIVE, 'Test 8c: Admin successfully re-activated centre');

    // -------------------------------------------------------------
    // Test 9: Reissue Activation Password
    // -------------------------------------------------------------
    const reissueResult = await centresService.reissueActivation(adminUser, createResult.centre.id);
    assert(!!reissueResult.temporaryPassword, 'Test 9a: New temporary activation password generated');

    const loginAfterReissue = await authService.login({
      identifier: testEmail,
      password: reissueResult.temporaryPassword,
    });
    assert(loginAfterReissue.mustChangePassword === true, 'Test 9b: Reissued password forces mustChangePassword = true');

    // -------------------------------------------------------------
    // Test 10: Clean Up Test Centre
    // -------------------------------------------------------------
    await prisma.centre.delete({ where: { id: createResult.centre.id } });
    await prisma.user.delete({ where: { id: createResult.user.id } });
    console.log('🧹 Cleaned up temporary test centre');

    console.log(`\n================================================================`);
    console.log(`🎉 ALL ${passed}/${total} SECURITY & FUNCTIONALITY TESTS PASSED SUCCESSFULLY!`);
    console.log(`================================================================\n`);
  } catch (error) {
    console.error('❌ Test suite failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runSecurityAndFunctionalityTests();
