import { ConfigType, registerAs } from '@nestjs/config'

import { env, envNumber } from '~/global/env'

import { assertStrongSecret, normalizeSecret } from './security.config'

export const memberAuthRegToken = 'memberAuth'

function expirySeconds(key: string, fallback: number): number {
  const seconds = envNumber(key, fallback)
  if (!Number.isSafeInteger(seconds) || seconds <= 0)
    throw new Error(`[member-auth] ${key} must be a positive integer in seconds`)
  return seconds
}

export const MemberAuthConfig = registerAs(memberAuthRegToken, () => {
  const accessSecret = assertStrongSecret('MEMBER_JWT_SECRET', env('MEMBER_JWT_SECRET'))
  const refreshSecret = assertStrongSecret('MEMBER_REFRESH_TOKEN_SECRET', env('MEMBER_REFRESH_TOKEN_SECRET'))
  const adminSecrets = [normalizeSecret(env('JWT_SECRET')), normalizeSecret(env('REFRESH_TOKEN_SECRET'))]
  if (accessSecret === refreshSecret || adminSecrets.includes(accessSecret) || adminSecrets.includes(refreshSecret))
    throw new Error('[member-auth] Member access and refresh secrets must be independent of one another and admin secrets')

  return {
    accessSecret,
    refreshSecret,
    accessExpire: expirySeconds('MEMBER_JWT_EXPIRE', 900),
    refreshExpire: expirySeconds('MEMBER_REFRESH_TOKEN_EXPIRE', 2592000),
  }
})

export type IMemberAuthConfig = ConfigType<typeof MemberAuthConfig>
