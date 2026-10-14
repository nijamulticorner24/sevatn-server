import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  LoginDto,
  ChangePasswordDto,
  RegisterByInvitationDto,
  VerifyRegistrationPaymentDto,
  UpdateLocationDto,
} from './dto/auth.dto';
import { JwtAuthGuard } from '../common/guards';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async registerCentre() {
    return this.authService.registerCentre();
  }

  @Get('invitation/:token')
  async validateInvitation(@Param('token') token: string) {
    return this.authService.validateInvitation(token);
  }

  @Post('register-by-invitation')
  async registerByInvitation(@Body() dto: RegisterByInvitationDto) {
    return this.authService.registerByInvitation(dto);
  }

  @Post('verify-registration-payment')
  async verifyRegistrationPayment(@Body() dto: VerifyRegistrationPaymentDto) {
    return this.authService.verifyRegistrationPayment(dto);
  }

  @Post('location')
  @UseGuards(JwtAuthGuard)
  async updateLocation(@Request() req: any, @Body() dto: UpdateLocationDto) {
    return this.authService.updateLocation(req.user.id, dto);
  }

  @Post('login')
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  async changePassword(@Request() req: any, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(req.user.id, dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getProfile(@Request() req: any) {
    return this.authService.getMyProfile(req.user.id);
  }
}
