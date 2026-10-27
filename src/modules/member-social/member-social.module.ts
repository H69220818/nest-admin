import { HttpModule } from '@nestjs/axios'
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { TypeOrmModule } from '@nestjs/typeorm'

import { WechatConfig } from '~/config/wechat.config'
import { MemberAuthModule } from '~/modules/member-auth/member-auth.module'

import { MemberIdentityEntity } from './member-identity.entity'
import { MemberSocialController } from './member-social.controller'
import { MemberSocialService } from './member-social.service'
import { WechatMiniappProvider } from './providers/wechat-miniapp.provider'
import { WechatOAuthProvider } from './providers/wechat-oauth.provider'

@Module({
  imports: [ConfigModule.forFeature(WechatConfig), TypeOrmModule.forFeature([MemberIdentityEntity]), HttpModule, MemberAuthModule],
  controllers: [MemberSocialController],
  providers: [MemberSocialService, WechatOAuthProvider, WechatMiniappProvider],
  exports: [MemberSocialService],
})
export class MemberSocialModule {}
