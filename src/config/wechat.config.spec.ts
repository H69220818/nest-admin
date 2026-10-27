import { WechatConfig } from './wechat.config'

describe('wechatConfig', () => {
  const keys = ['WECHAT_OAUTH_ENABLED', 'WECHAT_OAUTH_MODE', 'WECHAT_OAUTH_APP_ID', 'WECHAT_OAUTH_APP_SECRET', 'WECHAT_OAUTH_CALLBACK_URL', 'WECHAT_OAUTH_SCOPE', 'WECHAT_OAUTH_RETURN_ORIGINS', 'WECHAT_OAUTH_STATE_TTL_SECONDS', 'WECHAT_OAUTH_HTTP_TIMEOUT_MS', 'WECHAT_MINIAPP_ENABLED', 'WECHAT_MINIAPP_APP_ID', 'WECHAT_MINIAPP_APP_SECRET', 'WECHAT_MINIAPP_CODE_TTL_SECONDS', 'WECHAT_MINIAPP_HTTP_TIMEOUT_MS']
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

  it('leaves miniapp independently disabled until explicitly configured', () => {
    enable()
    expect(WechatConfig()).toMatchObject({ miniapp: { enabled: false, codeTtlSeconds: 300, httpTimeoutMs: 5000 } })
  })

  it('configures miniapp independently from OAuth', () => {
    Object.assign(process.env, { WECHAT_MINIAPP_ENABLED: 'true', WECHAT_MINIAPP_APP_ID: 'wx-mini', WECHAT_MINIAPP_APP_SECRET: 'mini-private-secret', WECHAT_MINIAPP_CODE_TTL_SECONDS: '600', WECHAT_MINIAPP_HTTP_TIMEOUT_MS: '1000' })
    expect(WechatConfig()).toMatchObject({ enabled: false, miniapp: { enabled: true, appId: 'wx-mini', appSecret: 'mini-private-secret', codeTtlSeconds: 600, httpTimeoutMs: 1000 } })
  })

  it.each([
    ['WECHAT_MINIAPP_APP_ID', ''],
    ['WECHAT_MINIAPP_APP_ID', 'invalid app'],
    ['WECHAT_MINIAPP_APP_SECRET', '  '],
    ['WECHAT_MINIAPP_CODE_TTL_SECONDS', '299'],
    ['WECHAT_MINIAPP_CODE_TTL_SECONDS', '601'],
    ['WECHAT_MINIAPP_CODE_TTL_SECONDS', '300.5'],
    ['WECHAT_MINIAPP_HTTP_TIMEOUT_MS', '0'],
    ['WECHAT_MINIAPP_HTTP_TIMEOUT_MS', '5001'],
    ['WECHAT_MINIAPP_HTTP_TIMEOUT_MS', '1.5'],
  ])('rejects invalid miniapp config %s without exposing the secret', (key, value) => {
    Object.assign(process.env, { WECHAT_MINIAPP_ENABLED: 'true', WECHAT_MINIAPP_APP_ID: 'wx-mini', WECHAT_MINIAPP_APP_SECRET: 'mini-private-secret', [key]: value })
    expect(() => WechatConfig()).toThrow(key)
    expect(() => WechatConfig()).not.toThrow('mini-private-secret')
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
