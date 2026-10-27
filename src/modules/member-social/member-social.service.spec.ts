import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common'
import Redis from 'ioredis'
import { EntityManager, FindOperator, QueryFailedError } from 'typeorm'

import { IWechatConfig } from '~/config/wechat.config'
import { MemberTokenService } from '~/modules/member-auth/services/member-token.service'
import { SmsCodeService } from '~/modules/member-auth/services/sms-code.service'
import { MemberIdentityProvider, MemberStatus } from '~/modules/member/member.constant'
import { MemberEntity } from '~/modules/member/member.entity'

import { MemberIdentityEntity } from './member-identity.entity'
import { MemberSocialService } from './member-social.service'
import { NormalizedSocialIdentity } from './providers/member-social-provider'
import { WechatOAuthProvider } from './providers/wechat-oauth.provider'

describe('memberSocialService', () => {
  const config: IWechatConfig = { enabled: true, mode: 'website', appId: 'wx-app', appSecret: 'secret', callbackUrl: 'https://api.example/callback', scope: 'snsapi_login', returnOrigins: ['https://member.example'], stateTtlSeconds: 600, httpTimeoutMs: 5000 }
  const identity: NormalizedSocialIdentity = { provider: MemberIdentityProvider.WechatOAuth, tenant: 'wx-app', subject: 'openid-1', unionId: 'union-1', profile: { displayName: 'Alice', avatar: 'https://image.example/avatar' } }
  let service: MemberSocialService
  let members: MemberEntity[]
  let identities: MemberIdentityEntity[]
  let states: Map<string, { value: string, expires: number }>
  let redis: { set: jest.Mock, eval: jest.Mock }
  let manager: { findOne: jest.Mock, find: jest.Mock, create: jest.Mock, save: jest.Mock, delete: jest.Mock }
  let root: { transaction: jest.Mock }
  let provider: WechatOAuthProvider
  let issue: jest.Mock
  let consumeCode: jest.Mock
  let sendCode: jest.Mock

  beforeEach(() => {
    members = [1, 2].map(id => Object.assign(new MemberEntity(), { id, phone: `+861380013800${id}`, status: MemberStatus.Enabled, phoneVerifiedAt: new Date(), parentId: null }))
    identities = []
    states = new Map()
    const matches = (row: object, where: object) => Object.entries(where).every(([key, value]) => value instanceof FindOperator ? row[key] !== value.value : row[key] === value)
    const rows = (entity: unknown) => entity === MemberEntity ? members : identities
    manager = {
      findOne: jest.fn(async (entity, { where }) => rows(entity).find(row => matches(row, where)) ?? null),
      find: jest.fn(async (entity, { where }) => rows(entity).filter(row => matches(row, where))),
      create: jest.fn((Entity, data) => Object.assign(new Entity(), data)),
      save: jest.fn(async (entity, row) => {
        if (identities.some(existing => existing.provider === row.provider && existing.providerTenant === row.providerTenant && (existing.providerSubject === row.providerSubject || existing.memberId === row.memberId)))
          throw new QueryFailedError('INSERT', [], { code: 'ER_DUP_ENTRY', errno: 1062 } as any)
        const result = Object.assign(row, { id: identities.length + 1, createdAt: new Date('2026-10-27T00:00:00Z') })
        identities.push(result)
        return result
      }),
      delete: jest.fn(async (entity, where) => {
        const before = identities.length
        identities = identities.filter(row => !matches(row, where))
        return { affected: before - identities.length }
      }),
    }
    root = { transaction: jest.fn(async (...args) => args.at(-1)(manager)) }
    redis = {
      set: jest.fn(async (key, value, ex, ttl, nx) => {
        expect(ex).toBe('EX')
        expect(nx).toBe('NX')
        if (states.has(key))
          return null
        states.set(key, { value, expires: Date.now() + ttl * 1000 })
        return 'OK'
      }),
      eval: jest.fn(async (script, count, key) => {
        const state = states.get(key)
        states.delete(key)
        return state && state.expires > Date.now() ? state.value : null
      }),
    }
    provider = new WechatOAuthProvider(config, {} as any)
    jest.spyOn(provider, 'exchangeCode').mockResolvedValue(identity)
    issue = jest.fn(async id => ({ accessToken: `member-access-${id}`, refreshToken: `member-refresh-${id}` }))
    consumeCode = jest.fn(async (phone, purpose, code) => {
      if (code !== '123456' || purpose !== 'unbind')
        throw new BadRequestException('Invalid SMS code')
    })
    sendCode = jest.fn(async () => ({ success: true }))
    service = new MemberSocialService(config, redis as unknown as Redis, root as unknown as EntityManager, provider, { issue } as unknown as MemberTokenService, { consumeCode, sendCode } as unknown as SmsCodeService)
  })

  const getState = (result: { authorizationUrl: string }) => new URL(result.authorizationUrl).searchParams.get('state')!

  it('creates unpredictable expiring state bound to the authenticated member and return URL', async () => {
    const first = await service.createOAuthState(1, 'bind', 'https://member.example/profile?tab=wechat')
    const second = await service.createOAuthState(1, 'bind', 'https://member.example/profile')
    expect(getState(first)).toMatch(/^[a-f0-9]{64}$/)
    expect(getState(first)).not.toBe(getState(second))
    expect(first.expiresIn).toBe(600)
    expect([...states.values()][0].expires - Date.now()).toBeGreaterThan(590000)
    expect(JSON.parse([...states.values()][0].value)).toMatchObject({ memberId: 1, intent: 'bind', returnUrl: 'https://member.example/profile?tab=wechat', tenant: 'wx-app' })
  })

  it.each([undefined, 0, -1, 999])('rejects bind state without a valid member context %p', async (memberId) => {
    await expect(service.createOAuthState(memberId, 'bind', 'https://member.example/')).rejects.toBeInstanceOf(UnauthorizedException)
    expect(states.size).toBe(0)
  })

  it.each(['https://member.example.attacker.test/', 'https://attacker.test/', '//member.example/', 'javascript:alert(1)', 'https://user:password@member.example/', 'https://member.example:8443/'])('rejects an untrusted return URL %s', async (url) => {
    await expect(service.createOAuthState(undefined, 'login', url)).rejects.toBeInstanceOf(BadRequestException)
    expect(states.size).toBe(0)
  })

  it('consumes a bind state exactly once, binding only its stored member', async () => {
    const state = getState(await service.createOAuthState(1, 'bind', 'https://member.example/profile'))
    const results = await Promise.allSettled([service.consumeOAuthCallback('code', state), service.consumeOAuthCallback('code', state)])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(identities).toHaveLength(1)
    expect(identities[0].memberId).toBe(1)
    expect(issue).not.toHaveBeenCalled()
    expect(states.size).toBe(0)
  })

  it('rejects expired state before contacting the provider', async () => {
    const state = getState(await service.createOAuthState(undefined, 'login', 'https://member.example/'))
    for (const value of states.values()) value.expires = Date.now() - 1
    await expect(service.consumeOAuthCallback('code', state)).rejects.toBeInstanceOf(BadRequestException)
    expect(provider.exchangeCode).not.toHaveBeenCalled()
  })

  it('does not restore consumed state after an upstream failure', async () => {
    const state = getState(await service.createOAuthState(undefined, 'login', 'https://member.example/'))
    jest.mocked(provider.exchangeCode).mockRejectedValue(new BadRequestException())
    await expect(service.consumeOAuthCallback('code', state)).rejects.toThrow()
    await expect(service.consumeOAuthCallback('code', state)).rejects.toThrow()
    expect(provider.exchangeCode).toHaveBeenCalledTimes(1)
  })

  it('rejects binding when the member was disabled after state creation', async () => {
    const state = getState(await service.createOAuthState(1, 'bind', 'https://member.example/'))
    members[0].status = MemberStatus.Disable
    await expect(service.consumeOAuthCallback('code', state)).rejects.toBeInstanceOf(UnauthorizedException)
    expect(identities).toHaveLength(0)
  })

  it('stores only identity fields and returns a safe projection', async () => {
    const binding = await service.bindIdentity(1, { ...identity, accessToken: 'provider-access', refreshToken: 'provider-refresh' } as any)
    expect(identities[0]).toMatchObject({ memberId: 1, provider: 'wechat_oauth', providerTenant: 'wx-app', providerSubject: 'openid-1', unionId: 'union-1' })
    expect(Object.keys(binding).sort()).toEqual(['avatar', 'createdAt', 'displayName', 'id', 'provider', 'tenant'])
    expect(JSON.stringify(identities)).not.toMatch(/provider-access|provider-refresh/)
    expect(root.transaction).toHaveBeenCalledWith('SERIALIZABLE', expect.any(Function))
  })

  it('rejects an identity owned by another member', async () => {
    await service.bindIdentity(1, identity)
    await expect(service.bindIdentity(2, identity)).rejects.toBeInstanceOf(ConflictException)
    expect(identities).toHaveLength(1)
  })

  it('rejects a second identity for the same member, provider and tenant', async () => {
    await service.bindIdentity(1, identity)
    await expect(service.bindIdentity(1, { ...identity, subject: 'other-openid' })).rejects.toBeInstanceOf(ConflictException)
    expect(identities[0].providerSubject).toBe('openid-1')
  })

  it('rejects union-ID collision across providers and tenants without merging', async () => {
    await service.bindIdentity(1, identity)
    await expect(service.bindIdentity(2, { ...identity, provider: MemberIdentityProvider.WechatMiniapp, tenant: 'mini-app', subject: 'mini-openid' })).rejects.toBeInstanceOf(ConflictException)
    expect(identities).toHaveLength(1)
    expect(members).toHaveLength(2)
  })

  it('allows the same member to explicitly bind another tenant with the same union ID', async () => {
    await service.bindIdentity(1, identity)
    await service.bindIdentity(1, { ...identity, provider: MemberIdentityProvider.WechatMiniapp, tenant: 'mini-app', subject: 'mini-openid' })
    expect(identities).toHaveLength(2)
  })

  it('uses database uniqueness as the final concurrent identity conflict boundary', async () => {
    const results = await Promise.allSettled([service.bindIdentity(1, identity), service.bindIdentity(2, identity)])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException)
    expect(identities).toHaveLength(1)
  })

  it('redacts a deadlock when concurrent union-ID checks conflict', async () => {
    manager.save.mockRejectedValue(new QueryFailedError('INSERT', [], { code: 'ER_LOCK_DEADLOCK', errno: 1213 } as any))
    await expect(service.bindIdentity(1, identity)).rejects.toBeInstanceOf(ConflictException)
  })

  it('rejects unknown identity login without creating a member', async () => {
    await expect(service.loginByIdentity(identity)).rejects.toBeInstanceOf(UnauthorizedException)
    expect(identities).toHaveLength(0)
    expect(members).toHaveLength(2)
    expect(issue).not.toHaveBeenCalled()
  })

  it('logs in the exact bound identity through MemberTokenService', async () => {
    await service.bindIdentity(1, identity)
    const state = getState(await service.createOAuthState(undefined, 'login', 'https://member.example/dashboard'))
    expect(await service.consumeOAuthCallback('code', state)).toEqual({ intent: 'login', returnUrl: 'https://member.example/dashboard', accessToken: 'member-access-1', refreshToken: 'member-refresh-1' })
    await expect(service.loginByIdentity({ ...identity, tenant: 'different-app' })).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('rejects disabled member social login', async () => {
    await service.bindIdentity(1, identity)
    members[0].status = MemberStatus.Disable
    await expect(service.loginByIdentity(identity)).rejects.toBeInstanceOf(UnauthorizedException)
    expect(issue).not.toHaveBeenCalled()
  })

  it('lists only the requesting member bindings without identifiers or tokens', async () => {
    await service.bindIdentity(1, identity)
    await service.bindIdentity(2, { ...identity, subject: 'openid-2', unionId: 'union-2' })
    const listed = await service.listBindings(1)
    expect(listed).toHaveLength(1)
    expect(listed[0].displayName).toBe('Alice')
    expect(JSON.stringify(listed)).not.toMatch(/openid|union|memberId|providerSubject|Token/)
  })

  it('sends unbind SMS only to the authenticated member base phone', async () => {
    await expect(service.sendUnbindCode(1, { ip: '192.0.2.1', deviceId: 'device' })).resolves.toEqual({ success: true })
    expect(sendCode).toHaveBeenCalledWith('+8613800138001', 'unbind', { ip: '192.0.2.1', deviceId: 'device' })
  })

  it('requires purpose-specific SMS and preserves the phone after unbinding', async () => {
    await service.bindIdentity(1, identity)
    await expect(service.unbindIdentity(1, identity.provider, identity.tenant, '000000')).rejects.toThrow()
    expect(identities).toHaveLength(1)
    await expect(service.unbindIdentity(2, identity.provider, identity.tenant, '123456')).rejects.toBeInstanceOf(NotFoundException)
    await service.unbindIdentity(1, identity.provider, identity.tenant, '123456')
    expect(consumeCode).toHaveBeenLastCalledWith('+8613800138001', 'unbind', '123456')
    expect(identities).toHaveLength(0)
    expect(members[0]).toMatchObject({ phone: '+8613800138001', parentId: null, status: MemberStatus.Enabled })
    await expect(service.loginByIdentity(identity)).rejects.toBeInstanceOf(UnauthorizedException)
  })
})
