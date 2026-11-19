import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  UseGuards,
  Request,
  BadRequestException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { S3StorageService } from '../common/storage/s3-storage.service';
import {
  LoginDto,
  ChangePasswordDto,
  RegisterByInvitationDto,
  VerifyRegistrationPaymentDto,
  UpdateLocationDto,
  ForgotPasswordDto,
  VerifyOtpDto,
  ResetPasswordDto,
  RequestEmailChangeDto,
  VerifyEmailChangeDto,
} from './dto/auth.dto';
import { JwtAuthGuard, RateLimiterGuard } from '../common/guards';
import { Throttle } from '../common/decorators';

@Controller('auth')
@UseGuards(RateLimiterGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly s3Storage: S3StorageService,
  ) {}

  @Post('upload-proof')
  @Throttle(15, 60)
  async uploadProof(@Body() body: { image: string; folder?: string }) {
    if (!body?.image) {
      throw new BadRequestException('Image data is required');
    }
    const url = await this.s3Storage.uploadProofImage(body.image, body.folder || 'proofs');
    return { url };
  }

  @Post('register')
  async registerCentre() {
    return this.authService.registerCentre();
  }

  @Get('invitation/:token')
  @Throttle(30, 60)
  async validateInvitation(@Param('token') token: string) {
    return this.authService.validateInvitation(token);
  }

  @Post('register-by-invitation')
  @Throttle(5, 60)
  async registerByInvitation(@Body() dto: RegisterByInvitationDto) {
    return this.authService.registerByInvitation(dto);
  }

  @Post('verify-registration-payment')
  @Throttle(10, 60)
  async verifyRegistrationPayment(@Body() dto: VerifyRegistrationPaymentDto) {
    return this.authService.verifyRegistrationPayment(dto);
  }

  @Post('location')
  @UseGuards(JwtAuthGuard)
  async updateLocation(@Request() req: any, @Body() dto: UpdateLocationDto) {
    return this.authService.updateLocation(req.user.id, dto);
  }

  @Get('centre/:code')
  @Throttle(30, 60)
  async getPublicCentreInfo(@Param('code') code: string) {
    return this.authService.getPublicCentreInfo(code);
  }

  @Post('login')
  @Throttle(10, 60)
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('forgot-password')
  @Throttle(5, 60)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('verify-otp')
  @Throttle(10, 60)
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  @Post('reset-password')
  @Throttle(5, 60)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @Throttle(5, 60)
  async changePassword(@Request() req: any, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(req.user.id, dto);
  }

  @Post('request-email-change')
  @UseGuards(JwtAuthGuard)
  @Throttle(5, 60)
  async requestEmailChange(@Request() req: any, @Body() dto: RequestEmailChangeDto) {
    return this.authService.requestEmailChange(req.user.id, dto);
  }

  @Post('verify-email-change')
  @UseGuards(JwtAuthGuard)
  @Throttle(10, 60)
  async verifyEmailChange(@Request() req: any, @Body() dto: VerifyEmailChangeDto) {
    return this.authService.verifyEmailChange(req.user.id, dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getProfile(@Request() req: any) {
    return this.authService.getMyProfile(req.user.id);
  }
}
