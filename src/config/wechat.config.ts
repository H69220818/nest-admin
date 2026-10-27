import { registerAs } from '@nestjs/config'

import { env, envBoolean, envNumber } from '~/global/env'

export const wechatRegToken = 'wechat'

export interface IWechatConfig {
  enabled: boolean
  mode: 'website' | 'official_account'
  appId: string
  appSecret: string
  callbackUrl: string
  scope: 'snsapi_login' | 'snsapi_base' | 'snsapi_userinfo'
  returnOrigins: string[]
  stateTtlSeconds: number
  httpTimeoutMs: number
}

export const WechatConfig = registerAs(wechatRegToken, (): IWechatConfig => {
  const enabled = envBoolean('WECHAT_OAUTH_ENABLED', false)
  const mode = env('WECHAT_OAUTH_MODE', 'website') as IWechatConfig['mode']
  const appId = env('WECHAT_OAUTH_APP_ID')
  const appSecret = env('WECHAT_OAUTH_APP_SECRET')
  const callbackUrl = env('WECHAT_OAUTH_CALLBACK_URL')
  const scope = env('WECHAT_OAUTH_SCOPE') as IWechatConfig['scope']
  const returnOrigins = env('WECHAT_OAUTH_RETURN_ORIGINS').split(',').map(value => value.trim()).filter(Boolean)
  const stateTtlSeconds = envNumber('WECHAT_OAUTH_STATE_TTL_SECONDS', 600)
  const httpTimeoutMs = envNumber('WECHAT_OAUTH_HTTP_TIMEOUT_MS', 5000)

  const invalid = (key: string): never => {
    throw new Error(`[wechat] Invalid or missing ${key}`)
  }
  if (!Number.isInteger(stateTtlSeconds) || stateTtlSeconds < 300 || stateTtlSeconds > 600)
    invalid('WECHAT_OAUTH_STATE_TTL_SECONDS')
  if (!Number.isInteger(httpTimeoutMs) || httpTimeoutMs < 1 || httpTimeoutMs > 5000)
    invalid('WECHAT_OAUTH_HTTP_TIMEOUT_MS')
  if (enabled) {
    if (!['website', 'official_account'].includes(mode))
      invalid('WECHAT_OAUTH_MODE')
    if (!/^[\w-]{1,128}$/.test(appId))
      invalid('WECHAT_OAUTH_APP_ID')
    if (!appSecret.trim())
      invalid('WECHAT_OAUTH_APP_SECRET')
    if (!(mode === 'website' ? ['snsapi_login'] : ['snsapi_base', 'snsapi_userinfo']).includes(scope))
      invalid('WECHAT_OAUTH_SCOPE')
    try {
      const url = new URL(callbackUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
        invalid('WECHAT_OAUTH_CALLBACK_URL')
    }
    catch {
      invalid('WECHAT_OAUTH_CALLBACK_URL')
    }
    if (!returnOrigins.length)
      invalid('WECHAT_OAUTH_RETURN_ORIGINS')
    for (const origin of returnOrigins) {
      try {
        const url = new URL(origin)
        if (!['http:', 'https:'].includes(url.protocol) || origin !== url.origin)
          invalid('WECHAT_OAUTH_RETURN_ORIGINS')
      }
      catch {
        invalid('WECHAT_OAUTH_RETURN_ORIGINS')
      }
    }
  }
  return { enabled, mode, appId, appSecret, callbackUrl, scope, returnOrigins, stateTtlSeconds, httpTimeoutMs }
})
