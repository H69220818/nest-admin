import { MemberAuthConfig } from './member-auth.config'

describe('memberAuthConfig', () => {
  const keys = ['MEMBER_JWT_SECRET', 'MEMBER_REFRESH_TOKEN_SECRET', 'MEMBER_JWT_EXPIRE', 'MEMBER_REFRESH_TOKEN_EXPIRE', 'JWT_SECRET', 'REFRESH_TOKEN_SECRET']
  let original: (string | undefined)[]

  beforeEach(() => {
    original = keys.map(key => process.env[key])
    process.env.MEMBER_JWT_SECRET = 'member-access-secret-at-least-32-characters'
    process.env.MEMBER_REFRESH_TOKEN_SECRET = 'member-refresh-secret-at-least-32-characters'
    process.env.JWT_SECRET = 'admin-access-secret-at-least-32-characters'
    process.env.REFRESH_TOKEN_SECRET = 'admin-refresh-secret-at-least-32-characters'
    delete process.env.MEMBER_JWT_EXPIRE
    delete process.env.MEMBER_REFRESH_TOKEN_EXPIRE
  })

  afterEach(() => {
    keys.forEach((key, index) => {
      if (original[index] === undefined)
        delete process.env[key]
      else
        process.env[key] = original[index]
    })
  })

  it('uses independent member secrets and expiry defaults', () => {
    expect(MemberAuthConfig()).toEqual({
      accessSecret: process.env.MEMBER_JWT_SECRET,
      refreshSecret: process.env.MEMBER_REFRESH_TOKEN_SECRET,
      accessExpire: 900,
      refreshExpire: 2592000,
    })
  })

  it.each(['MEMBER_JWT_SECRET', 'MEMBER_REFRESH_TOKEN_SECRET'])('fails closed for missing or weak %s', (key) => {
    delete process.env[key]
    expect(() => MemberAuthConfig()).toThrow(key)
    process.env[key] = 'secret'
    expect(() => MemberAuthConfig()).toThrow(key)
  })

  it.each(['JWT_SECRET', 'REFRESH_TOKEN_SECRET', 'MEMBER_REFRESH_TOKEN_SECRET'])('rejects access-secret reuse from %s', (key) => {
    process.env.MEMBER_JWT_SECRET = process.env[key]
    expect(() => MemberAuthConfig()).toThrow(/independent/)
  })

  it.each(['JWT_SECRET', 'REFRESH_TOKEN_SECRET'])('rejects refresh-secret reuse from %s', (key) => {
    process.env.MEMBER_REFRESH_TOKEN_SECRET = process.env[key]
    expect(() => MemberAuthConfig()).toThrow(/independent/)
  })

  it.each(['0', '-1', 'NaN', '1.5', 'Infinity', ''])('rejects invalid expiry %p', (value) => {
    process.env.MEMBER_JWT_EXPIRE = value
    expect(() => MemberAuthConfig()).toThrow(/MEMBER_JWT_EXPIRE/)
    process.env.MEMBER_JWT_EXPIRE = '900'
    process.env.MEMBER_REFRESH_TOKEN_EXPIRE = value
    expect(() => MemberAuthConfig()).toThrow(/MEMBER_REFRESH_TOKEN_EXPIRE/)
  })

  it('accepts configured expiry seconds', () => {
    process.env.MEMBER_JWT_EXPIRE = '600'
    process.env.MEMBER_REFRESH_TOKEN_EXPIRE = '3600'
    expect(MemberAuthConfig()).toMatchObject({ accessExpire: 600, refreshExpire: 3600 })
  })
})
