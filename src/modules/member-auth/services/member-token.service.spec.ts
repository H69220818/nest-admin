import { createHash, createHmac, randomUUID } from 'node:crypto'

import { UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { EntityManager } from 'typeorm'

import { MemberStatus } from '~/modules/member/member.constant'
import { MemberEntity } from '~/modules/member/member.entity'
import { MemberService } from '~/modules/member/member.service'

import { MemberAccessTokenEntity } from '../entities/member-access-token.entity'
import { MemberRefreshTokenEntity } from '../entities/member-refresh-token.entity'

import { MemberTokenService } from './member-token.service'

const config = {
  accessSecret: 'member-access-secret-at-least-32-characters',
  refreshSecret: 'member-refresh-secret-at-least-32-characters',
  accessExpire: 900,
  refreshExpire: 2592000,
}
const adminSecret = 'admin-secret-independent-of-member-secrets'
type TokenRow = MemberAccessTokenEntity | MemberRefreshTokenEntity

// External database boundary: atomic snapshots and a serialized transaction queue.
// Lock assertions below separately verify the queries needed by real MySQL.
class TokenStore {
  access: MemberAccessTokenEntity[] = []
  refresh: MemberRefreshTokenEntity[] = []
  member = Object.assign(new MemberEntity(), { id: 7, status: MemberStatus.Enabled })
  failRefreshInsert = false
  locks: { target: unknown, options: any }[] = []
  private pending: Promise<unknown> = Promise.resolve()

  manager = this.makeManager(false)

  private makeManager(inTransaction: boolean): EntityManager {
    const rows = (target: unknown): any[] => target === MemberAccessTokenEntity ? this.access : target === MemberRefreshTokenEntity ? this.refresh : [this.member]
    const matches = (row: any, where: object) => Object.entries(where).every(([key, value]) => row[key] === value)
    return {
      transaction: <T>(callback: (manager: EntityManager) => Promise<T>) => {
        const operation = this.pending.then(async () => {
          const access = this.access.map(row => ({ ...row }))
          const refresh = this.refresh.map(row => ({ ...row }))
          try {
            return await callback(this.makeManager(true))
          }
          catch (error) {
            this.access = access as MemberAccessTokenEntity[]
            this.refresh = refresh as MemberRefreshTokenEntity[]
            throw error
          }
        })
        this.pending = operation.catch(() => {})
        return operation
      },
      findOne: async (target: unknown, options: any) => {
        if (options.lock) {
          if (!inTransaction)
            throw new Error('Lock requested outside a transaction')
          this.locks.push({ target, options })
        }
        const row = rows(target).find(row => matches(row, options.where))
        return row ? { ...row } : null
      },
      findOneBy: async (target: unknown, where: object) => {
        const row = rows(target).find(row => matches(row, where))
        return row ? { ...row } : null
      },
      find: async (target: unknown, options: any) => {
        if (options.lock)
          this.locks.push({ target, options })
        return rows(target).filter(row => matches(row, options.where)).map(row => ({ ...row }))
      },
      create: (Target: any, input: object) => Object.assign(new Target(), input),
      save: async (target: any, row: TokenRow) => {
        if (!inTransaction)
          throw new Error('Token writes must be transactional')
        if (target === MemberRefreshTokenEntity && this.failRefreshInsert)
          throw new Error('Refresh insert failed')
        const table = rows(target)
        row.id ??= randomUUID()
        const index = table.findIndex(existing => existing.id === row.id)
        if (index < 0)
          table.push({ ...row })
        else
          table[index] = { ...row }
        return row
      },
      update: async (target: unknown, where: object, values: object) => {
        if (!inTransaction)
          throw new Error('Token writes must be transactional')
        for (const row of rows(target).filter(row => matches(row, where)))
          Object.assign(row, values)
        return { affected: 1 }
      },
    } as unknown as EntityManager
  }
}

describe('memberTokenService', () => {
  let store: TokenStore
  let service: MemberTokenService
  let jwt: JwtService
  let members: { findEnabledById: jest.Mock }

  beforeEach(() => {
    store = new TokenStore()
    jwt = new JwtService({ secret: adminSecret })
    members = { findEnabledById: jest.fn(async (id: number) => id === store.member.id && store.member.status === MemberStatus.Enabled ? store.member : null) }
    service = new MemberTokenService(jwt, config, store.manager, members as unknown as MemberService)
  })

  it('issues only member claims with independent signing, opaque refresh, and hashed persistence', async () => {
    const pair = await service.issue(7)
    const payload = jwt.verify(pair.accessToken, { secret: config.accessSecret })
    expect(payload).toEqual({
      sub: '7',
      aud: 'member',
      tokenType: 'access',
      sessionId: store.access[0].id,
      pv: expect.any(Number),
      iat: expect.any(Number),
      exp: expect.any(Number),
    })
    expect(Number.isSafeInteger(payload.pv) && payload.pv > 0).toBe(true)
    expect(payload.exp - payload.iat).toBe(900)
    expect(() => jwt.verify(pair.accessToken)).toThrow()
    expect(() => jwt.verify(pair.accessToken, { secret: config.refreshSecret })).toThrow()
    expect(pair.refreshToken).toMatch(/^[\w-]{64}$/)
    expect(store.access[0].tokenHash).toBe(createHash('sha256').update(pair.accessToken).digest('hex'))
    expect(store.refresh[0].tokenHash).toBe(createHmac('sha256', config.refreshSecret).update(pair.refreshToken).digest('hex'))
    expect(JSON.stringify([...store.access, ...store.refresh])).not.toContain(pair.refreshToken)
    expect(store.refresh[0].expiresAt.getTime() - store.refresh[0].createdAt.getTime()).toBe(2592000000)
    await expect(service.verifyAccess(pair.accessToken)).resolves.toMatchObject({ sub: '7', aud: 'member', sessionId: store.access[0].id })
  })

  it('permits two simultaneous sessions for one member', async () => {
    const [first, second] = await Promise.all([service.issue(7), service.issue(7)])
    expect(store.access).toHaveLength(2)
    expect(first.accessToken).not.toBe(second.accessToken)
    await expect(service.verifyAccess(first.accessToken)).resolves.toMatchObject({ sub: '7' })
    await expect(service.verifyAccess(second.accessToken)).resolves.toMatchObject({ sub: '7' })
  })

  it.each([MemberStatus.Disable, MemberStatus.Cancelled])('rejects unavailable member status %s during issue, verification and rotation', async (status) => {
    const pair = await service.issue(7)
    store.member.status = status
    await expect(service.issue(7)).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(service.verifyAccess(pair.accessToken)).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(service.rotate(pair.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException)
    expect(store.refresh).toHaveLength(1)
  })

  it('rejects an unknown member', async () => {
    await expect(service.issue(999)).rejects.toBeInstanceOf(UnauthorizedException)
    expect(store.access).toEqual([])
  })

  it.each(['expired', 'revoked', 'hash', 'owner', 'missing'])('rejects a %s persisted access session', async (failure) => {
    const pair = await service.issue(7)
    if (failure === 'expired')
      store.access[0].expiresAt = new Date(0)
    if (failure === 'revoked')
      store.access[0].revokedAt = new Date()
    if (failure === 'hash')
      store.access[0].tokenHash = '0'.repeat(64)
    if (failure === 'owner')
      store.access[0].memberId = 8
    if (failure === 'missing')
      store.access = []
    await expect(service.verifyAccess(pair.accessToken)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it.each([
    { aud: 'admin' },
    { aud: ['member', 'admin'] },
    { tokenType: 'refresh' },
    { sub: 7 },
    { sub: '0' },
    { sub: '7.5' },
    { pv: 0 },
    { pv: '1' },
    { sessionId: '' },
    { exp: 1 },
    { exp: undefined },
  ])('rejects signed but invalid access claims %p even with a matching stored hash', async (overrides) => {
    const pair = await service.issue(7)
    const payload = jwt.decode(pair.accessToken) as Record<string, unknown>
    const claims = { ...payload, ...overrides }
    for (const key of Object.keys(claims)) {
      if (claims[key] === undefined)
        delete claims[key]
    }
    const forged = jwt.sign(claims, { secret: config.accessSecret })
    store.access[0].tokenHash = createHash('sha256').update(forged).digest('hex')
    await expect(service.verifyAccess(forged)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('rejects admin-signed and malformed tokens', async () => {
    const pair = await service.issue(7)
    const adminSigned = jwt.sign(jwt.decode(pair.accessToken) as object)
    await expect(service.verifyAccess(adminSigned)).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(service.verifyAccess('garbage')).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('rotates immediately with distinct access values, retaining consumed generations in the same session', async () => {
    const first = await service.issue(7)
    const sessionId = store.access[0].id
    const second = await service.rotate(first.refreshToken)
    const third = await service.rotate(second.refreshToken)
    expect(new Set([first.accessToken, second.accessToken, third.accessToken]).size).toBe(3)
    expect(store.access).toHaveLength(1)
    expect(store.access[0].id).toBe(sessionId)
    expect(store.refresh).toHaveLength(3)
    expect(new Set(store.refresh.map(row => row.familyId)).size).toBe(1)
    expect(store.refresh.map(row => row.consumedAt)).toEqual([expect.any(Date), expect.any(Date), null])
    await expect(service.verifyAccess(first.accessToken)).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(service.verifyAccess(second.accessToken)).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(service.verifyAccess(third.accessToken)).resolves.toMatchObject({ sessionId })
    expect(store.locks[0]).toMatchObject({ target: MemberAccessTokenEntity, options: { where: { id: sessionId }, lock: { mode: 'pessimistic_write' } } })
    expect(store.locks[1]).toMatchObject({ target: MemberRefreshTokenEntity, options: { lock: { mode: 'pessimistic_write' } } })
  })

  it('refreshes an expired access token when refresh remains valid', async () => {
    const first = await service.issue(7)
    store.access[0].expiresAt = new Date(0)
    const second = await service.rotate(first.refreshToken)
    await expect(service.verifyAccess(second.accessToken)).resolves.toMatchObject({ sub: '7' })
  })

  it('commits family revocation on replay without affecting another login session', async () => {
    const first = await service.issue(7)
    const other = await service.issue(7)
    const second = await service.rotate(first.refreshToken)
    await expect(service.rotate(first.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException)
    expect(store.access[0].revokedAt).toEqual(expect.any(Date))
    expect(store.refresh.filter(row => row.accessTokenId === store.access[0].id).every(row => row.revokedAt !== null)).toBe(true)
    await expect(service.verifyAccess(second.accessToken)).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(service.rotate(second.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(service.verifyAccess(other.accessToken)).resolves.toMatchObject({ sub: '7' })
  })

  it('rejects replay even after the consumed refresh generation has expired', async () => {
    const first = await service.issue(7)
    const second = await service.rotate(first.refreshToken)
    store.refresh[0].expiresAt = new Date(0)
    await expect(service.rotate(first.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(service.verifyAccess(second.accessToken)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('makes a concurrent double refresh leave no returned pair usable', async () => {
    const first = await service.issue(7)
    const outcomes = await Promise.allSettled([service.rotate(first.refreshToken), service.rotate(first.refreshToken)])
    expect(outcomes.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const winner = outcomes.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ accessToken: string, refreshToken: string }>
    await expect(service.verifyAccess(winner.value.accessToken)).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(service.rotate(winner.value.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it.each(['expired', 'revoked', 'session-revoked', 'unknown'])('rejects %s refresh values without issuing a pair', async (failure) => {
    const pair = await service.issue(7)
    if (failure === 'expired')
      store.refresh[0].expiresAt = new Date(0)
    if (failure === 'revoked')
      store.refresh[0].revokedAt = new Date()
    if (failure === 'session-revoked')
      store.access[0].revokedAt = new Date()
    await expect(service.rotate(failure === 'unknown' ? 'unknown' : pair.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException)
    expect(store.refresh).toHaveLength(1)
  })

  it('rolls back consumed state and access replacement when refresh insertion fails', async () => {
    const first = await service.issue(7)
    store.failRefreshInsert = true
    await expect(service.rotate(first.refreshToken)).rejects.toThrow('Refresh insert failed')
    expect(store.refresh[0].consumedAt).toBeNull()
    expect(store.refresh).toHaveLength(1)
    await expect(service.verifyAccess(first.accessToken)).resolves.toMatchObject({ sub: '7' })
    store.failRefreshInsert = false
    await expect(service.rotate(first.refreshToken)).resolves.toHaveProperty('accessToken')
  })

  it('rolls back a new session if its refresh insertion fails', async () => {
    store.failRefreshInsert = true
    await expect(service.issue(7)).rejects.toThrow('Refresh insert failed')
    expect(store.access).toEqual([])
    expect(store.refresh).toEqual([])
  })

  it('revokes one session on logout, then all remaining sessions without deleting replay evidence', async () => {
    const first = await service.issue(7)
    const second = await service.issue(7)
    await service.revokeSession(store.access[0].id)
    await service.revokeSession(store.access[0].id)
    await service.revokeSession(randomUUID())
    await expect(service.verifyAccess(first.accessToken)).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(service.rotate(first.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(service.verifyAccess(second.accessToken)).resolves.toMatchObject({ sub: '7' })
    await service.revokeAll(999)
    await expect(service.verifyAccess(second.accessToken)).resolves.toMatchObject({ sub: '7' })
    await service.revokeAll(7)
    await expect(service.verifyAccess(second.accessToken)).rejects.toBeInstanceOf(UnauthorizedException)
    await expect(service.rotate(second.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException)
    expect(store.access).toHaveLength(2)
    expect(store.refresh).toHaveLength(2)
    expect(store.refresh.every(row => row.revokedAt !== null)).toBe(true)
  })
})
