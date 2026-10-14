import * as crypto from 'crypto';

export interface EncryptedPayload {
  encryptedData: string;
  iv: string;
  authTag: string;
}

export class CredentialCrypto {
  private static getKey(): Buffer {
    const secret = process.env.CREDENTIAL_ENCRYPTION_KEY;
    if (!secret || secret.trim().length < 16) {
      throw new Error(
        'FATAL: CREDENTIAL_ENCRYPTION_KEY environment variable is missing, empty, or too short (minimum 16 characters required). Refusing to process credentials.'
      );
    }
    return crypto.createHash('sha256').update(secret.trim()).digest();
  }

  static encrypt(plaintext: string): EncryptedPayload {
    const key = this.getKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return {
      encryptedData: encrypted,
      iv: iv.toString('hex'),
      authTag,
    };
  }

  static decrypt(encryptedData: string, ivHex: string, authTagHex: string): string {
    const key = this.getKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
