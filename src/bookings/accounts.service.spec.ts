import { Test, TestingModule } from '@nestjs/testing';
import { AccountsService } from './accounts.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';
import { CredentialCrypto } from '../common/security/credential-crypto';

describe('AccountsService - Password Reveal & Management', () => {
  let service: AccountsService;
  let prisma: any;

  beforeEach(async () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-secret-key-minimum-16-characters!';

    prisma = {
      bookingAccount: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountsService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
      ],
    }).compile();

    service = module.get<AccountsService>(AccountsService);
  });

  it('successfully decrypts and reveals official account password for authorized user', async () => {
    const rawPassword = 'SecretPortalPassword@2026';
    const encrypted = CredentialCrypto.encrypt(rawPassword);

    prisma.bookingAccount.findUnique.mockResolvedValue({
      id: 'acc-1',
      userId: 'user-123',
      encryptedPassword: encrypted.encryptedData,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.authTag,
    });

    const res = await service.getAccountPassword('acc-1', 'user-123');
    expect(res).toEqual({ password: rawPassword });
  });

  it('rejects access and throws NotFoundException when requested by an unauthorized user', async () => {
    prisma.bookingAccount.findUnique.mockResolvedValue({
      id: 'acc-1',
      userId: 'user-other',
      encryptedPassword: 'enc',
      encryptionIv: 'iv',
      encryptionTag: 'tag',
    });

    await expect(service.getAccountPassword('acc-1', 'user-123')).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when account does not exist', async () => {
    prisma.bookingAccount.findUnique.mockResolvedValue(null);

    await expect(service.getAccountPassword('non-existent', 'user-123')).rejects.toThrow(NotFoundException);
  });
});
