import { HttpService } from '@nestjs/axios'
import { BadGatewayException, BadRequestException, GatewayTimeoutException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common'

import { IWechatConfig, WechatConfig } from '~/config/wechat.config'
import { MemberIdentityProvider } from '~/modules/member/member.constant'

import { MemberSocialProvider, NormalizedSocialIdentity } from './member-social-provider'

@Injectable()
export class WechatMiniappProvider implements MemberSocialProvider {
  constructor(
    @Inject(WechatConfig.KEY) private readonly config: IWechatConfig,
    private readonly http: HttpService,
  ) {}

  async exchangeCode(code: string): Promise<NormalizedSocialIdentity> {
    const config = this.config.miniapp
    if (!config.enabled)
      throw new ServiceUnavailableException('微信小程序登录尚未配置')
    if (typeof code !== 'string' || !/^[\w-]{1,512}$/.test(code))
      throw new BadRequestException('微信小程序授权码无效')

    try {
      const { data } = await this.http.axiosRef.get('https://api.weixin.qq.com/sns/jscode2session', {
        params: { appid: config.appId, secret: config.appSecret, js_code: code, grant_type: 'authorization_code' },
        timeout: config.httpTimeoutMs,
        maxRedirects: 0,
        maxContentLength: 64 * 1024,
      })
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || (data.errcode !== undefined && data.errcode !== 0)
        || !this.identifier(data.openid)
        || (data.unionid !== undefined && !this.identifier(data.unionid))) {
        throw new Error('Invalid provider response')
      }
      // Explicit projection discards session_key and every other provider field.
      return {
        provider: MemberIdentityProvider.WechatMiniapp,
        tenant: config.appId,
        subject: data.openid,
        ...(data.unionid ? { unionId: data.unionid } : {}),
      }
    }
    catch (error) {
      // Axios errors may carry the code, AppSecret and session_key. Never propagate them.
      if (['ECONNABORTED', 'ETIMEDOUT'].includes((error as { code?: string })?.code))
        throw new GatewayTimeoutException('微信小程序授权服务超时')
      throw new BadGatewayException('微信小程序授权服务暂不可用')
    }
  }

  private identifier(value: unknown): value is string {
    return typeof value === 'string' && /^[\w-]{1,191}$/.test(value)
  }
}
