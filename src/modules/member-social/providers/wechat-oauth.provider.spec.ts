import { HttpService } from '@nestjs/axios'
import { BadGatewayException, GatewayTimeoutException, ServiceUnavailableException } from '@nestjs/common'

import { IWechatConfig } from '~/config/wechat.config'

import { WechatOAuthProvider } from './wechat-oauth.provider'

describe('wechatOAuthProvider', () => {
  const config = { enabled: true, mode: 'website', appId: 'wx-website', appSecret: 'app-secret', callbackUrl: 'https://api.example/callback?fixed=yes', scope: 'snsapi_login', returnOrigins: ['https://member.example'], stateTtlSeconds: 600, httpTimeoutMs: 5000 } as IWechatConfig
  let get: jest.Mock
  let provider: WechatOAuthProvider

  beforeEach(() => {
    get = jest.fn()
      .mockResolvedValueOnce({ data: { access_token: 'provider-access', refresh_token: 'provider-refresh', expires_in: 7200, openid: 'openid-1', unionid: 'union-1', scope: 'snsapi_login' } })
      .mockResolvedValueOnce({ data: { openid: 'openid-1', unionid: 'union-1', nickname: 'Alice', headimgurl: 'https://image.example/avatar.png' } })
    provider = new WechatOAuthProvider(config, { axiosRef: { get } } as unknown as HttpService)
  })

  it.each([
    ['website', 'snsapi_login', '/connect/qrconnect'],
    ['official_account', 'snsapi_base', '/connect/oauth2/authorize'],
    ['official_account', 'snsapi_userinfo', '/connect/oauth2/authorize'],
  ])('constructs exact authorization parameters for %s with %s', (mode, scope, path) => {
    provider = new WechatOAuthProvider({ ...config, mode, scope } as IWechatConfig, {} as HttpService)
    const url = new URL(provider.authorizationUrl('state123'))
    expect(url.origin + url.pathname).toBe(`https://open.weixin.qq.com${path}`)
    expect(Object.fromEntries(url.searchParams)).toEqual({ appid: 'wx-website', redirect_uri: 'https://api.example/callback?fixed=yes', response_type: 'code', scope, state: 'state123' })
    expect(url.hash).toBe('#wechat_redirect')
  })

  it('exchanges code server-side and returns only normalized identity fields', async () => {
    const identity = await provider.exchangeCode('code123')
    expect(identity).toEqual({ provider: 'wechat_oauth', tenant: 'wx-website', subject: 'openid-1', unionId: 'union-1', profile: { displayName: 'Alice', avatar: 'https://image.example/avatar.png' } })
    expect(get).toHaveBeenNthCalledWith(1, 'https://api.weixin.qq.com/sns/oauth2/access_token', expect.objectContaining({ params: { appid: 'wx-website', secret: 'app-secret', code: 'code123', grant_type: 'authorization_code' }, timeout: 5000, maxRedirects: 0 }))
    expect(JSON.stringify(identity)).not.toMatch(/provider-access|provider-refresh|app-secret/)
  })

  it('uses base-scope openid without fetching unavailable profile information', async () => {
    get = jest.fn().mockResolvedValue({ data: { access_token: 'provider-access', openid: 'openid-base', scope: 'snsapi_base' } })
    provider = new WechatOAuthProvider({ ...config, mode: 'official_account', scope: 'snsapi_base' }, { axiosRef: { get } } as unknown as HttpService)
    expect(await provider.exchangeCode('base-code')).toEqual({ provider: 'wechat_oauth', tenant: 'wx-website', subject: 'openid-base' })
    expect(get).toHaveBeenCalledTimes(1)
  })

  it.each([
    { errcode: 40029, errmsg: 'private provider error app-secret provider-access' },
    { access_token: 'provider-access', openid: '', scope: 'snsapi_login' },
    { access_token: 'provider-access', openid: 'openid-1', scope: 'snsapi_base' },
    { access_token: 'provider-access', openid: ['openid-1'], scope: 'snsapi_login' },
  ])('rejects invalid exchange responses without exposing upstream details', async (data) => {
    get.mockReset().mockResolvedValue({ data })
    await expect(provider.exchangeCode('code')).rejects.toBeInstanceOf(BadGatewayException)
    await expect(provider.exchangeCode('code')).rejects.not.toThrow(/private|provider-access|app-secret/)
  })

  it.each([
    { openid: 'another-openid', unionid: 'union-1' },
    { openid: 'openid-1', unionid: 'different-union' },
    { errcode: 40001, errmsg: 'provider-access' },
  ])('rejects inconsistent or invalid userinfo', async (data) => {
    get.mockReset().mockResolvedValueOnce({ data: { access_token: 'provider-access', openid: 'openid-1', unionid: 'union-1', scope: 'snsapi_login' } }).mockResolvedValueOnce({ data })
    await expect(provider.exchangeCode('code')).rejects.toBeInstanceOf(BadGatewayException)
  })

  it.each(['ECONNABORTED', 'ETIMEDOUT'])('redacts upstream timeout %s', async (code) => {
    get.mockReset().mockRejectedValue(Object.assign(new Error('provider-access app-secret'), { code, config: { secret: 'app-secret' } }))
    await expect(provider.exchangeCode('code')).rejects.toBeInstanceOf(GatewayTimeoutException)
    await expect(provider.exchangeCode('code')).rejects.not.toThrow(/provider-access|app-secret/)
  })

  it('discards arbitrary Axios errors and request configuration', async () => {
    get.mockReset().mockRejectedValue(new Error('provider-access app-secret'))
    await expect(provider.exchangeCode('code')).rejects.toBeInstanceOf(BadGatewayException)
  })

  it('fails closed when OAuth is disabled', async () => {
    provider = new WechatOAuthProvider({ ...config, enabled: false }, {} as HttpService)
    expect(() => provider.authorizationUrl('state')).toThrow(ServiceUnavailableException)
    await expect(provider.exchangeCode('code')).rejects.toBeInstanceOf(ServiceUnavailableException)
  })
})
