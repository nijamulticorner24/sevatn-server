import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as crypto from 'crypto';

@Injectable()
export class S3StorageService {
  private readonly logger = new Logger(S3StorageService.name);
  private s3Client: S3Client | null = null;
  private readonly bucketName: string;
  private readonly region: string;

  constructor(private configService: ConfigService) {
    this.bucketName =
      this.configService.get<string>('AWS_S3_BUCKET') ||
      process.env.AWS_S3_BUCKET ||
      'sevatn-payment-proofs-232428703302';

    this.region =
      this.configService.get<string>('AWS_REGION') ||
      process.env.AWS_REGION ||
      'ap-south-1';

    const accessKeyId =
      this.configService.get<string>('AWS_ACCESS_KEY_ID') ||
      process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey =
      this.configService.get<string>('AWS_SECRET_ACCESS_KEY') ||
      process.env.AWS_SECRET_ACCESS_KEY;

    if (accessKeyId && secretAccessKey) {
      try {
        this.s3Client = new S3Client({
          region: this.region,
          credentials: {
            accessKeyId: accessKeyId.trim(),
            secretAccessKey: secretAccessKey.trim(),
          },
        });
        this.logger.log(`Initialized AWS S3 Client for bucket: ${this.bucketName} (${this.region})`);
      } catch (err: any) {
        this.logger.error(`Error initializing AWS S3 Client: ${err.message}`);
        this.s3Client = null;
      }
    } else {
      // Default AWS provider chain (e.g. AWS CLI, IAM Role, EC2/ECS metadata)
      try {
        this.s3Client = new S3Client({ region: this.region });
        this.logger.log(`Initialized AWS S3 Client via default credentials for bucket: ${this.bucketName} (${this.region})`);
      } catch (err: any) {
        this.logger.warn(`AWS S3 credentials not found. S3 uploads will fallback gracefully: ${err.message}`);
        this.s3Client = null;
      }
    }
  }

  /**
   * Uploads an image (base64 Data URI or raw buffer) to AWS S3.
   * If already a remote URL (http/https), returns it as is.
   * If upload succeeds, returns the permanent S3 URL.
   * If S3 is unconfigured or upload fails, returns the original input as safe fallback.
   */
  async uploadProofImage(input?: string | null, folder: string = 'payment-proofs'): Promise<string | null> {
    if (!input || typeof input !== 'string') {
      return null;
    }

    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }

    // Already a remote URL (S3, CDN, or external HTTP)
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }

    if (!trimmed.startsWith('data:image/')) {
      return trimmed;
    }

    try {
      const mimeMatch = trimmed.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/);
      const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      const base64Data = trimmed.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');

      let ext = 'jpg';
      if (mimeType.includes('png')) ext = 'png';
      else if (mimeType.includes('webp')) ext = 'webp';
      else if (mimeType.includes('jpeg')) ext = 'jpg';

      const key = `${folder}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;

      if (!this.s3Client) {
        this.logger.warn(`S3 Client not active. Skipping upload for key ${key}`);
        return trimmed;
      }

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: buffer,
          ContentType: mimeType,
        }),
      );

      const s3Url = `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${key}`;
      this.logger.log(`Successfully uploaded proof image to S3: ${s3Url}`);
      return s3Url;
    } catch (err: any) {
      this.logger.error(`Failed to upload proof image to S3: ${err.message}`);
      return trimmed; // Graceful fallback to original data URI
    }
  }
}
