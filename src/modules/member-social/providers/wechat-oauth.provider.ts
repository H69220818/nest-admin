import { HttpService } from '@nestjs/axios'
import { BadGatewayException, BadRequestException, GatewayTimeoutException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common'

import { IWechatConfig, WechatConfig } from '~/config/wechat.config'
import { MemberIdentityProvider } from '~/modules/member/member.constant'

import { MemberSocialProvider, NormalizedSocialIdentity } from './member-social-provider'

@Injectable()
export class WechatOAuthProvider implements MemberSocialProvider {
  constructor(
    @Inject(WechatConfig.KEY) private readonly config: IWechatConfig,
    private readonly http: HttpService,
  ) {}

  authorizationUrl(state: string): string {
    this.assertEnabled()
    const url = new URL(this.config.mode === 'website'
      ? 'https://open.weixin.qq.com/connect/qrconnect'
      : 'https://open.weixin.qq.com/connect/oauth2/authorize')
    url.search = new URLSearchParams({
      appid: this.config.appId,
      redirect_uri: this.config.callbackUrl,
      response_type: 'code',
      scope: this.config.scope,
      state,
    }).toString()
    url.hash = 'wechat_redirect'
    return url.toString()
  }

  async exchangeCode(code: string): Promise<NormalizedSocialIdentity> {
    this.assertEnabled()
    if (typeof code !== 'string' || !/^[\w-]{1,512}$/.test(code))
      throw new BadRequestException('微信授权码无效')

    const token = await this.request('https://api.weixin.qq.com/sns/oauth2/access_token', {
      appid: this.config.appId,
      secret: this.config.appSecret,
      code,
      grant_type: 'authorization_code',
    })
    if (!this.identifier(token.openid) || typeof token.access_token !== 'string' || !token.access_token
      || typeof token.scope !== 'string' || !token.scope.split(',').includes(this.config.scope)
      || (token.unionid !== undefined && !this.identifier(token.unionid))) {
      throw new BadGatewayException('微信授权响应无效')
    }

    const identity: NormalizedSocialIdentity = {
      provider: MemberIdentityProvider.WechatOAuth,
      tenant: this.config.appId,
      subject: token.openid,
      ...(token.unionid ? { unionId: token.unionid as string } : {}),
    }
    if (this.config.scope !== 'snsapi_base') {
      const profile = await this.request('https://api.weixin.qq.com/sns/userinfo', {
        access_token: token.access_token,
        openid: identity.subject,
        lang: 'zh_CN',
      })
      if (profile.openid !== identity.subject
        || (profile.unionid !== undefined && !this.identifier(profile.unionid))
        || (identity.unionId && profile.unionid && identity.unionId !== profile.unionid)) {
        throw new BadGatewayException('微信授权响应无效')
      }
      if (profile.unionid)
        identity.unionId = profile.unionid as string
      identity.profile = {}
      if (typeof profile.nickname === 'string')
        identity.profile.displayName = profile.nickname.slice(0, 64)
      if (typeof profile.headimgurl === 'string' && profile.headimgurl.length <= 500 && /^https?:\/\//.test(profile.headimgurl))
        identity.profile.avatar = profile.headimgurl
    }
    return identity
  }

  private assertEnabled(): void {
    if (!this.config.enabled)
      throw new ServiceUnavailableException('微信授权登录尚未配置')
  }

  private identifier(value: unknown): value is string {
    return typeof value === 'string' && /^[\w-]{1,191}$/.test(value)
  }

  private async request(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    try {
      const { data } = await this.http.axiosRef.get(url, {
        params,
        timeout: this.config.httpTimeoutMs,
        maxRedirects: 0,
        maxContentLength: 64 * 1024,
      })
      if (!data || typeof data !== 'object' || Array.isArray(data) || (data.errcode !== undefined && data.errcode !== 0))
        throw new Error('Invalid provider response')
      return data
    }
    catch (error) {
      // Never propagate Axios request/response objects, URLs, tokens, or provider errors.
      if (['ECONNABORTED', 'ETIMEDOUT'].includes((error as { code?: string })?.code))
        throw new GatewayTimeoutException('微信授权服务超时')
      throw new BadGatewayException('微信授权服务暂不可用')
    }
  }
}
