import { Body, Controller, Delete, Get, Header, Headers, Param, ParseEnumPipe, Post, Query, Req } from '@nestjs/common'
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger'
import { IsString, Matches, MaxLength } from 'class-validator'
import { FastifyRequest } from 'fastify'

import { ApiSecurityAuth } from '~/common/decorators/swagger.decorator'
import { MemberAuth, PublicAuth } from '~/modules/member-auth/decorators/member-auth.decorator'
import { MemberUser } from '~/modules/member-auth/decorators/member-user.decorator'
import { MemberIdentityProvider } from '~/modules/member/member.constant'

import { MemberSocialService } from './member-social.service'

export class MemberOAuthUrlDto {
  @ApiProperty({ description: '授权完成后的前端地址，必须属于已配置的可信来源' })
  @IsString()
  @MaxLength(2048)
  @Matches(/^https?:\/\//)
  returnUrl: string
}

export class MemberOAuthCallbackDto {
  @ApiProperty({ description: '微信授权码' })
  @IsString()
  @Matches(/^[\w-]{1,512}$/)
  code: string

  @ApiProperty({ description: '服务端签发的一次性授权 state' })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  state: string
}

export class MemberUnbindDto {
  @ApiProperty({ description: '绑定列表中的 tenant（平台 AppID）' })
  @IsString()
  @Matches(/^[\w-]{1,128}$/)
  tenant: string

  @ApiProperty({ description: '发到当前会员手机号的 unbind 用途验证码' })
  @IsString()
  @Matches(/^\d{6}$/)
  code: string
}

export class MemberMiniappCodeDto {
  @ApiProperty({ description: 'wx.login() 返回的一次性授权码' })
  @IsString()
  @Matches(/^[\w-]{1,512}$/)
  code: string
}

@ApiTags('Member - 第三方身份')
@Controller('member')
export class MemberSocialController {
  constructor(private readonly social: MemberSocialService) {}

  @Post('auth/wechat/oauth-url')
  @PublicAuth()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '创建微信登录授权会话；未绑定身份不能登录' })
  loginUrl(@Body() dto: MemberOAuthUrlDto) {
    return this.social.createOAuthState(undefined, 'login', dto.returnUrl)
  }

  @Post('social/wechat-oauth/bind-url')
  @MemberAuth()
  @ApiSecurityAuth()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '为当前会员创建微信绑定授权会话' })
  bindUrl(@MemberUser() member: IMemberAuthUser, @Body() dto: MemberOAuthUrlDto) {
    return this.social.createOAuthState(Number(member.sub), 'bind', dto.returnUrl)
  }

  @Get('auth/wechat/callback')
  @PublicAuth()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '消费一次性微信授权；返回绑定结果或会员令牌及可信回跳地址' })
  callback(@Query() dto: MemberOAuthCallbackDto) {
    // No token-bearing redirects. The frontend consumes this JSON response and returnUrl.
    return this.social.consumeOAuthCallback(dto.code, dto.state)
  }

  @Post('auth/wechat-miniapp')
  @PublicAuth()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '微信小程序登录；仅允许已绑定身份登录，不创建会员' })
  loginMiniapp(@Body() dto: MemberMiniappCodeDto) {
    return this.social.loginMiniapp(dto.code)
  }

  @Post('social/wechat-miniapp/bind')
  @MemberAuth()
  @ApiSecurityAuth()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '使用一次性小程序授权码为当前会员绑定微信身份' })
  bindMiniapp(@MemberUser() member: IMemberAuthUser, @Body() dto: MemberMiniappCodeDto) {
    return this.social.bindMiniapp(Number(member.sub), dto.code)
  }

  @Get('social')
  @MemberAuth()
  @ApiSecurityAuth()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '获取当前会员的安全第三方绑定列表' })
  list(@MemberUser() member: IMemberAuthUser) {
    return this.social.listBindings(Number(member.sub))
  }

  @Post('social/unbind-sms')
  @MemberAuth()
  @ApiSecurityAuth()
  @ApiOperation({ summary: '发送解绑验证码到当前会员手机号' })
  sendUnbindCode(@MemberUser() member: IMemberAuthUser, @Req() request: FastifyRequest, @Headers('x-device-id') deviceId?: string) {
    return this.social.sendUnbindCode(Number(member.sub), { ip: request.ip, deviceId })
  }

  @Delete('social/:provider')
  @MemberAuth()
  @ApiSecurityAuth()
  @ApiOperation({ summary: '用手机号验证码确认解绑第三方身份；保留手机号登录' })
  unbind(@MemberUser() member: IMemberAuthUser, @Param('provider', new ParseEnumPipe(MemberIdentityProvider)) provider: MemberIdentityProvider, @Body() dto: MemberUnbindDto) {
    return this.social.unbindIdentity(Number(member.sub), provider, dto.tenant, dto.code)
  }
}
