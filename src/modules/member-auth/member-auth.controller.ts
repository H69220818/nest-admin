import { Body, Controller, Headers, Param, ParseEnumPipe, Post, Req } from '@nestjs/common'
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger'
import { IsString, Matches } from 'class-validator'
import { FastifyRequest } from 'fastify'

import { MemberAuth, PublicAuth } from './decorators/member-auth.decorator'
import { MemberUser } from './decorators/member-user.decorator'
import { MemberPhoneLoginDto, MemberRegisterDto, SendMemberSmsCodeDto } from './dto/member-auth.dto'
import { MemberAuthService } from './member-auth.service'
import { MemberTokenPair, MemberTokenService } from './services/member-token.service'
import { SmsCodeService } from './services/sms-code.service'

export class MemberRefreshDto {
  @ApiProperty({ description: '会员刷新令牌' })
  @IsString()
  @Matches(/^[\w-]{64}$/)
  refreshToken: string
}

// Public SMS endpoints cannot request a code for protected account operations.
enum PublicSmsPurpose {
  Register = 'register',
  Login = 'login',
}

@ApiTags('Member - 会员认证')
@Controller('member/auth')
export class MemberAuthController {
  constructor(
    private readonly auth: MemberAuthService,
    private readonly tokens: MemberTokenService,
    private readonly smsCodes: SmsCodeService,
  ) {}

  @PublicAuth()
  @Post('sms/:purpose')
  @ApiOperation({ summary: '发送注册或登录短信验证码' })
  sendCode(
    @Param('purpose', new ParseEnumPipe(PublicSmsPurpose)) purpose: PublicSmsPurpose,
    @Body() dto: SendMemberSmsCodeDto,
    @Req() request: FastifyRequest,
    @Headers('x-device-id') deviceId?: string,
  ): Promise<{ success: true }> {
    return this.smsCodes.sendCode(dto.phone, purpose, { ip: request.ip, deviceId })
  }

  @PublicAuth()
  @Post('register')
  @ApiOperation({ summary: '注册会员并签发会话' })
  async register(@Body() dto: MemberRegisterDto): Promise<MemberTokenPair> {
    const member = await this.auth.register(dto)
    return this.tokens.issue(member.id)
  }

  @PublicAuth()
  @Post('login')
  @ApiOperation({ summary: '会员手机号登录' })
  async login(@Body() dto: MemberPhoneLoginDto): Promise<MemberTokenPair> {
    const member = await this.auth.loginByPhone(dto)
    return this.tokens.issue(member.id)
  }

  @PublicAuth()
  @Post('refresh')
  @ApiOperation({ summary: '刷新会员会话' })
  refresh(@Body() dto: MemberRefreshDto): Promise<MemberTokenPair> {
    return this.tokens.rotate(dto.refreshToken)
  }

  @MemberAuth()
  @Post('logout')
  @ApiOperation({ summary: '注销当前会员会话' })
  async logout(@MemberUser() member: IMemberAuthUser): Promise<void> {
    await this.tokens.revokeSession(member.sessionId)
  }
}
