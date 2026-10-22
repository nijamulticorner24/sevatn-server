import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { MachineAuthGuard } from '../common/guards';
import { PrismaService } from '../prisma/prisma.service';
import { hashMachineToken } from '../common/security/token-hash';
import { WorkerStatus } from '@prisma/client';

describe('Phase 5: Worker Machine Authentication & Token Hashing Suite', () => {
  let guard: MachineAuthGuard;
  let mockPrisma: any;

  const rawToken = 'wkt_0123456789abcdef0123456789abcdef01234567';
  const rawTokenHash = hashMachineToken(rawToken);

  beforeEach(async () => {
    mockPrisma = {
      workerMachine: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MachineAuthGuard,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    guard = module.get<MachineAuthGuard>(MachineAuthGuard);
  });

  const createMockContext = (headers: Record<string, string> = {}) => {
    const request: any = {
      headers,
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  };

  it('authenticates active worker machine using valid raw token against SHA-256 verifier in DB', async () => {
    mockPrisma.workerMachine.findUnique.mockImplementation(({ where }: any) => {
      if (where.machineToken === rawTokenHash) {
        return Promise.resolve({
          id: 'wm-1',
          machineCode: 'PC-001',
          active: true,
          status: WorkerStatus.ONLINE,
          machineToken: rawTokenHash,
        });
      }
      return Promise.resolve(null);
    });

    const context = createMockContext({ 'x-machine-token': rawToken });
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    const req = context.switchToHttp().getRequest();
    expect(req.machine).toBeDefined();
    expect(req.machine.machineCode).toBe('PC-001');
  });

  it('authenticates via Authorization: Bearer <token> header as well', async () => {
    mockPrisma.workerMachine.findUnique.mockImplementation(({ where }: any) => {
      if (where.machineToken === rawTokenHash) {
        return Promise.resolve({
          id: 'wm-1',
          machineCode: 'PC-001',
          active: true,
          status: WorkerStatus.ONLINE,
          machineToken: rawTokenHash,
        });
      }
      return Promise.resolve(null);
    });

    const context = createMockContext({ authorization: `Bearer ${rawToken}` });
    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('rejects invalid or forged worker machine token with 401 Unauthorized', async () => {
    mockPrisma.workerMachine.findUnique.mockResolvedValue(null);

    const context = createMockContext({ 'x-machine-token': 'wkt_invalid_forged_token' });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects missing machine token with 401 Unauthorized', async () => {
    const context = createMockContext({});
    await expect(guard.canActivate(context)).rejects.toThrow(
      /Worker machine token missing in x-machine-token or Authorization header/
    );
  });

  it('rejects revoked or deactivated machine (active: false) with 401 Unauthorized', async () => {
    mockPrisma.workerMachine.findUnique.mockResolvedValue({
      id: 'wm-revoked',
      machineCode: 'PC-REVOKED',
      active: false, // Revoked by administrator
      status: WorkerStatus.STOPPED,
      machineToken: rawTokenHash,
    });

    const context = createMockContext({ 'x-machine-token': rawToken });
    await expect(guard.canActivate(context)).rejects.toThrow(
      /Invalid or inactive machine token/
    );
  });

  it('performs smooth zero-downtime auto-migration of legacy plaintext tokens to SHA-256 hash', async () => {
    const legacyPlaintextToken = 'wkt_legacy_unhashed_token_12345';
    const legacyHash = hashMachineToken(legacyPlaintextToken);

    // Initial lookup with hash returns null (not yet migrated)
    mockPrisma.workerMachine.findUnique.mockImplementation(({ where }: any) => {
      if (where.machineToken === legacyHash) {
        return Promise.resolve(null);
      }
      if (where.machineToken === legacyPlaintextToken) {
        return Promise.resolve({
          id: 'wm-legacy',
          machineCode: 'PC-LEGACY',
          active: true,
          status: WorkerStatus.ONLINE,
          machineToken: legacyPlaintextToken,
        });
      }
      return Promise.resolve(null);
    });

    mockPrisma.workerMachine.update.mockResolvedValue({
      id: 'wm-legacy',
      machineCode: 'PC-LEGACY',
      active: true,
      status: WorkerStatus.ONLINE,
      machineToken: legacyHash,
    });

    const context = createMockContext({ 'x-machine-token': legacyPlaintextToken });
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    // Verifies that the legacy record was automatically upgraded to SHA-256 verifier in DB
    expect(mockPrisma.workerMachine.update).toHaveBeenCalledWith({
      where: { id: 'wm-legacy' },
      data: { machineToken: legacyHash },
    });
  });

  it('rejects ordinary user JWT tokens from accessing machine endpoints', async () => {
    mockPrisma.workerMachine.findUnique.mockResolvedValue(null);

    const fakeUserJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEifQ.signature';
    const context = createMockContext({ authorization: `Bearer ${fakeUserJwt}` });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });
});
