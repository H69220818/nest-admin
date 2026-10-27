import { HttpService } from '@nestjs/axios'
import { BadGatewayException, BadRequestException, GatewayTimeoutException, Logger, ServiceUnavailableException } from '@nestjs/common'

import { IWechatConfig } from '~/config/wechat.config'

import { WechatMiniappProvider } from './wechat-miniapp.provider'

describe('wechatMiniappProvider', () => {
  const config = { miniapp: { enabled: true, appId: 'wx-miniapp', appSecret: 'mini-secret', codeTtlSeconds: 300, httpTimeoutMs: 5000 } } as unknown as IWechatConfig
  let get: jest.Mock
  let provider: WechatMiniappProvider

  beforeEach(() => {
    get = jest.fn().mockResolvedValue({ data: { openid: 'mini-openid', unionid: 'wechat-union', session_key: 'private-session-key', errcode: 0 } })
    provider = new WechatMiniappProvider(config, { axiosRef: { get } } as unknown as HttpService)
  })

  it('exchanges code2Session with the configured app and only returns trusted identity fields', async () => {
    expect(await provider.exchangeCode('wx-login-code')).toEqual({ provider: 'wechat_miniapp', tenant: 'wx-miniapp', subject: 'mini-openid', unionId: 'wechat-union' })
    expect(get).toHaveBeenCalledWith('https://api.weixin.qq.com/sns/jscode2session', {
      params: { appid: 'wx-miniapp', secret: 'mini-secret', js_code: 'wx-login-code', grant_type: 'authorization_code' },
      timeout: 5000,
      maxRedirects: 0,
      maxContentLength: 64 * 1024,
    })
  })

  it('accepts openid without optional unionid', async () => {
    get.mockResolvedValue({ data: { openid: 'mini-openid', session_key: 'private-session-key' } })
    expect(await provider.exchangeCode('code')).toEqual({ provider: 'wechat_miniapp', tenant: 'wx-miniapp', subject: 'mini-openid' })
  })

  it.each([null, [], {}, { session_key: 'private-session-key' }, { openid: '' }, { openid: ['mini-openid'] }, { openid: 'mini-openid', unionid: null }, { openid: 'mini-openid', unionid: 'invalid union' }, { errcode: 40029, errmsg: 'private-session-key mini-secret' }, { openid: 'mini-openid', errcode: '0' }])('rejects malformed or failed WeChat responses %p', async (data) => {
    get.mockResolvedValue({ data })
    await expect(provider.exchangeCode('code')).rejects.toBeInstanceOf(BadGatewayException)
    await expect(provider.exchangeCode('code')).rejects.not.toThrow(/private-session-key|mini-secret/)
  })

  it.each(['ECONNABORTED', 'ETIMEDOUT'])('normalizes timeout %s without carrying upstream secrets', async (code) => {
    get.mockRejectedValue(Object.assign(new Error('private-session-key mini-secret wx-login-code'), { code, config: { params: { secret: 'mini-secret' } } }))
    await expect(provider.exchangeCode('code')).rejects.toBeInstanceOf(GatewayTimeoutException)
    await expect(provider.exchangeCode('code')).rejects.not.toThrow(/private-session-key|mini-secret|wx-login-code/)
  })

  it('discards arbitrary upstream request/response error objects', async () => {
    get.mockRejectedValue(Object.assign(new Error('private-session-key mini-secret'), { response: { data: { session_key: 'private-session-key' } } }))
    await expect(provider.exchangeCode('code')).rejects.toBeInstanceOf(BadGatewayException)
    await expect(provider.exchangeCode('code')).rejects.not.toThrow(/private-session-key|mini-secret/)
  })

  it.each(['', 'invalid code', 'a'.repeat(513), undefined, {}])('rejects malformed code before calling WeChat %p', async (code) => {
    await expect(provider.exchangeCode(code as string)).rejects.toBeInstanceOf(BadRequestException)
    expect(get).not.toHaveBeenCalled()
  })

  it('fails closed when miniapp is disabled', async () => {
    provider = new WechatMiniappProvider({ miniapp: { enabled: false } } as unknown as IWechatConfig, { axiosRef: { get } } as unknown as HttpService)
    await expect(provider.exchangeCode('code')).rejects.toBeInstanceOf(ServiceUnavailableException)
    expect(get).not.toHaveBeenCalled()
  })

  it('does not log session_key or provider secrets', async () => {
    const logs = ['debug', 'log', 'warn', 'error', 'verbose'].map(method => jest.spyOn(Logger.prototype, method as 'log').mockImplementation(() => undefined))
    try {
      const identity = await provider.exchangeCode('code')
      expect(JSON.stringify(identity)).not.toMatch(/session_key|private-session-key|mini-secret/)
      expect(JSON.stringify(logs.flatMap(log => log.mock.calls))).not.toMatch(/session_key|private-session-key|mini-secret/)
    }
    finally {
      jest.restoreAllMocks()
    }
  })
})
