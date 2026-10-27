import { forwardRef, Module, ServiceUnavailableException } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { TypeOrmModule } from '@nestjs/typeorm'

import { MemberAuthConfig } from '~/config/member-auth.config'
import { MemberModule } from '~/modules/member/member.module'

import { MemberAccessTokenEntity } from './entities/member-access-token.entity'
import { MemberRefreshTokenEntity } from './entities/member-refresh-token.entity'
import { SMS_SENDER, SmsSender } from './member-auth.constant'
import { MemberAuthController } from './member-auth.controller'
import { MemberAuthService } from './member-auth.service'
import { MemberJwtAuthGuard } from './member-jwt-auth.guard'
import { MemberJwtStrategy } from './member-jwt.strategy'
import { MemberTokenService } from './services/member-token.service'
import { SmsCodeService } from './services/sms-code.service'

@Module({
  imports: [
    ConfigModule.forFeature(MemberAuthConfig),
    TypeOrmModule.forFeature([MemberAccessTokenEntity, MemberRefreshTokenEntity]),
    forwardRef(() => MemberModule),
    PassportModule,
    // MemberTokenService supplies its isolated secrets for every sign/verify call.
    JwtModule.register({}),
  ],
  controllers: [MemberAuthController],
  providers: [
    MemberAuthService,
    SmsCodeService,
    MemberTokenService,
    MemberJwtStrategy,
    MemberJwtAuthGuard,
    {
      provide: SMS_SENDER,
      useValue: {
        async sendCode() {
          throw new ServiceUnavailableException('会员短信服务尚未配置')
        },
      } satisfies SmsSender,
    },
  ],
  exports: [MemberAuthService, MemberTokenService, MemberJwtAuthGuard, SmsCodeService],
})
export class MemberAuthModule {}
