import { WechatConfig } from './wechat.config'

describe('wechatConfig', () => {
  const keys = ['WECHAT_OAUTH_ENABLED', 'WECHAT_OAUTH_MODE', 'WECHAT_OAUTH_APP_ID', 'WECHAT_OAUTH_APP_SECRET', 'WECHAT_OAUTH_CALLBACK_URL', 'WECHAT_OAUTH_SCOPE', 'WECHAT_OAUTH_RETURN_ORIGINS', 'WECHAT_OAUTH_STATE_TTL_SECONDS', 'WECHAT_OAUTH_HTTP_TIMEOUT_MS']
  let original: (string | undefined)[]

  beforeEach(() => {
    original = keys.map(key => process.env[key])
    keys.forEach(key => delete process.env[key])
  })

  afterEach(() => {
    keys.forEach((key, i) => {
      if (original[i] === undefined)
        delete process.env[key]
      else
        process.env[key] = original[i]
    })
  })

  function enable() {
    Object.assign(process.env, {
      WECHAT_OAUTH_ENABLED: 'true',
      WECHAT_OAUTH_MODE: 'website',
      WECHAT_OAUTH_APP_ID: 'wx-website',
      WECHAT_OAUTH_APP_SECRET: 'private-app-secret',
      WECHAT_OAUTH_CALLBACK_URL: 'https://api.example/member/auth/wechat/callback',
      WECHAT_OAUTH_SCOPE: 'snsapi_login',
      WECHAT_OAUTH_RETURN_ORIGINS: 'https://member.example,https://other.example:8443',
    })
  }

  it('leaves OAuth disabled until explicitly configured', () => {
    expect(WechatConfig().enabled).toBe(false)
  })

  it('preserves the exact configured app, scope and callback', () => {
    enable()
    expect(WechatConfig()).toMatchObject({ enabled: true, mode: 'website', appId: 'wx-website', scope: 'snsapi_login', callbackUrl: 'https://api.example/member/auth/wechat/callback', returnOrigins: ['https://member.example', 'https://other.example:8443'], stateTtlSeconds: 600, httpTimeoutMs: 5000 })
  })

  it.each(['snsapi_base', 'snsapi_userinfo'])('supports official account scope %s', (scope) => {
    enable()
    process.env.WECHAT_OAUTH_MODE = 'official_account'
    process.env.WECHAT_OAUTH_SCOPE = scope
    expect(WechatConfig()).toMatchObject({ mode: 'official_account', scope })
  })

  it.each(['WECHAT_OAUTH_APP_ID', 'WECHAT_OAUTH_APP_SECRET', 'WECHAT_OAUTH_CALLBACK_URL', 'WECHAT_OAUTH_SCOPE', 'WECHAT_OAUTH_RETURN_ORIGINS'])('fails closed for missing %s when enabled', (key) => {
    enable()
    delete process.env[key]
    expect(() => WechatConfig()).toThrow(key)
  })

  it.each([
    ['WECHAT_OAUTH_MODE', 'miniapp'],
    ['WECHAT_OAUTH_SCOPE', 'snsapi_userinfo'],
    ['WECHAT_OAUTH_CALLBACK_URL', 'javascript:alert(1)'],
    ['WECHAT_OAUTH_CALLBACK_URL', 'https://user:password@api.example/callback'],
    ['WECHAT_OAUTH_CALLBACK_URL', 'https://api.example/callback#fragment'],
    ['WECHAT_OAUTH_RETURN_ORIGINS', 'https://member.example/path'],
    ['WECHAT_OAUTH_RETURN_ORIGINS', '*'],
    ['WECHAT_OAUTH_RETURN_ORIGINS', 'https://user:password@member.example'],
    ['WECHAT_OAUTH_STATE_TTL_SECONDS', '299'],
    ['WECHAT_OAUTH_STATE_TTL_SECONDS', '601'],
    ['WECHAT_OAUTH_STATE_TTL_SECONDS', '300.5'],
    ['WECHAT_OAUTH_HTTP_TIMEOUT_MS', '0'],
  ])('rejects invalid %s without exposing the value', (key, value) => {
    enable()
    process.env[key] = value
    expect(() => WechatConfig()).toThrow(key)
    try {
      WechatConfig()
    }
    catch (error) {
      expect(String(error)).not.toContain('private-app-secret')
    }
  })
})
