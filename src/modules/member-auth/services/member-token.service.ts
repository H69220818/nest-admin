import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto'

import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { EntityManager } from 'typeorm'

import { IMemberAuthConfig, MemberAuthConfig } from '~/config/member-auth.config'
import { MemberStatus } from '~/modules/member/member.constant'
import { MemberEntity } from '~/modules/member/member.entity'
import { MemberService } from '~/modules/member/member.service'

import { MemberAccessTokenEntity } from '../entities/member-access-token.entity'
import { MemberRefreshTokenEntity } from '../entities/member-refresh-token.entity'

import { revokeLockedMemberSessions, revokeLockedSession } from './member-session-revocation'

export interface MemberTokenPair {
  accessToken: string
  refreshToken: string
}

@Injectable()
export class MemberTokenService {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(MemberAuthConfig.KEY) private readonly config: IMemberAuthConfig,
    private readonly entityManager: EntityManager,
    private readonly memberService: MemberService,
  ) {}

  async issue(memberId: number): Promise<MemberTokenPair> {
    return this.entityManager.transaction(async (manager) => {
      // All credential mutations lock member -> session -> refresh rows.
      // Keep this lock through insertion so disable cannot miss a pending login.
      const member = await manager.findOne(MemberEntity, {
        where: { id: memberId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!member || member.status !== MemberStatus.Enabled)
        throw new UnauthorizedException()

      const session = manager.create(MemberAccessTokenEntity, {
        id: randomUUID(),
        memberId,
        revokedAt: null,
        createdAt: new Date(),
      })
      return this.createPair(manager, session, randomUUID())
    })
  }

  async rotate(refreshToken: string): Promise<MemberTokenPair> {
    if (typeof refreshToken !== 'string' || !/^[\w-]{64}$/.test(refreshToken))
      throw new UnauthorizedException()

    const tokenHash = this.refreshHash(refreshToken)
    // These lookups only locate immutable ownership. Status is re-read under locks.
    const candidate = await this.entityManager.findOneBy(MemberRefreshTokenEntity, { tokenHash })
    if (!candidate)
      throw new UnauthorizedException()
    const owner = await this.entityManager.findOneBy(MemberAccessTokenEntity, { id: candidate.accessTokenId })
    if (!owner)
      throw new UnauthorizedException()

    const pair = await this.entityManager.transaction(async (manager) => {
      const member = await manager.findOne(MemberEntity, {
        where: { id: owner.memberId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!member)
        return null

      const session = await manager.findOne(MemberAccessTokenEntity, {
        where: { id: candidate.accessTokenId, memberId: member.id },
        lock: { mode: 'pessimistic_write' },
      })
      if (!session)
        return null

      const refresh = await manager.findOne(MemberRefreshTokenEntity, {
        where: { tokenHash, accessTokenId: session.id },
        lock: { mode: 'pessimistic_write' },
      })
      if (!refresh)
        return null

      if (refresh.consumedAt) {
        await revokeLockedSession(manager, session.id)
        // Return, do not throw: replay revocation must commit before the 401.
        return null
      }

      if (session.revokedAt || refresh.revokedAt || refresh.expiresAt.getTime() <= Date.now())
        return null

      if (member.status !== MemberStatus.Enabled)
        return null

      await manager.update(MemberRefreshTokenEntity, { id: refresh.id }, { consumedAt: new Date() })
      return this.createPair(manager, session, refresh.familyId)
    })

    if (!pair)
      throw new UnauthorizedException()
    return pair
  }

  async verifyAccess(token: string): Promise<IMemberAuthUser> {
    let payload: IMemberAuthUser
    try {
      payload = await this.jwtService.verifyAsync<IMemberAuthUser>(token, {
        secret: this.config.accessSecret,
        algorithms: ['HS256'],
        audience: 'member',
      })
    }
    catch {
      throw new UnauthorizedException()
    }

    if (payload.aud !== 'member' || payload.tokenType !== 'access'
      || typeof payload.sub !== 'string' || !/^[1-9]\d*$/.test(payload.sub)
      || !Number.isSafeInteger(Number(payload.sub))
      || typeof payload.sessionId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(payload.sessionId)
      || !Number.isSafeInteger(payload.pv) || payload.pv <= 0
      || !Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException()
    }

    const session = await this.entityManager.findOneBy(MemberAccessTokenEntity, { id: payload.sessionId })
    if (!session || session.memberId !== Number(payload.sub) || session.revokedAt
      || session.expiresAt.getTime() <= Date.now() || session.tokenHash !== this.accessHash(token)) {
      throw new UnauthorizedException()
    }

    if (!await this.memberService.findEnabledById(session.memberId))
      throw new UnauthorizedException()

    return payload
  }

  async revokeSession(sessionId: string): Promise<void> {
    const owner = await this.entityManager.findOneBy(MemberAccessTokenEntity, { id: sessionId })
    if (!owner)
      return
    await this.entityManager.transaction(async (manager) => {
      const member = await manager.findOne(MemberEntity, {
        where: { id: owner.memberId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!member)
        return
      const session = await manager.findOne(MemberAccessTokenEntity, {
        where: { id: sessionId, memberId: member.id },
        lock: { mode: 'pessimistic_write' },
      })
      if (session)
        await revokeLockedSession(manager, session.id)
    })
  }

  async revokeAll(memberId: number): Promise<void> {
    await this.entityManager.transaction(async (manager) => {
      const member = await manager.findOne(MemberEntity, {
        where: { id: memberId },
        lock: { mode: 'pessimistic_write' },
      })
      if (member)
        await revokeLockedMemberSessions(manager, member.id)
    })
  }

  private async createPair(manager: EntityManager, session: MemberAccessTokenEntity, familyId: string): Promise<MemberTokenPair> {
    const now = new Date()
    const payload: IMemberAuthUser = {
      sub: String(session.memberId),
      aud: 'member',
      tokenType: 'access',
      sessionId: session.id,
      // Avoid identical access JWTs on rotations occurring in the same second.
      pv: randomInt(1, 2 ** 48 - 1),
    }
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.config.accessSecret,
      algorithm: 'HS256',
      expiresIn: this.config.accessExpire,
    })
    const refreshToken = randomBytes(48).toString('base64url')
    session.tokenHash = this.accessHash(accessToken)
    session.expiresAt = new Date((Math.floor(now.getTime() / 1000) + this.config.accessExpire) * 1000)
    await manager.save(MemberAccessTokenEntity, session)
    await manager.save(MemberRefreshTokenEntity, manager.create(MemberRefreshTokenEntity, {
      id: randomUUID(),
      accessTokenId: session.id,
      familyId,
      tokenHash: this.refreshHash(refreshToken),
      expiresAt: new Date(now.getTime() + this.config.refreshExpire * 1000),
      consumedAt: null,
      revokedAt: null,
      createdAt: now,
    }))
    return { accessToken, refreshToken }
  }

  private accessHash(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  private refreshHash(token: string): string {
    return createHmac('sha256', this.config.refreshSecret).update(token).digest('hex')
  }
}
