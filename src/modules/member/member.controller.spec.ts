import { CanActivate, ExecutionContext, HttpStatus, Module, NotFoundException, UnprocessableEntityException, ValidationPipe } from '@nestjs/common'
import { PATH_METADATA } from '@nestjs/common/constants'
import { APP_GUARD } from '@nestjs/core'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { Repository } from 'typeorm'

import { PERMISSION_KEY } from '~/modules/auth/auth.constant'
import { AUTH_ROUTE_KEY } from '~/modules/member-auth/decorators/member-auth.decorator'
import { MemberAuthModule } from '~/modules/member-auth/member-auth.module'
import { MemberTokenService } from '~/modules/member-auth/services/member-token.service'

import { MemberProfileController } from './member-profile.controller'
import { MemberStatus } from './member.constant'
import { MemberController } from './member.controller'
import { MemberEntity } from './member.entity'
import { MemberModule } from './member.module'
import { MemberService } from './member.service'

class MemberRequestGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest()
    request.member = { sub: '42', aud: 'member', tokenType: 'access', sessionId: 'own-session', pv: 1 }
    request.user = { uid: 99 }
    return true
  }
}

describe('member profile and admin management', () => {
  let app: NestFastifyApplication
  let service: MemberService
  let rows: MemberEntity[]
  let sessions: number[]
  let repository: { findOne: jest.Mock, update: jest.Mock, createQueryBuilder: jest.Mock }
  let query: { select: jest.Mock, orderBy: jest.Mock, take: jest.Mock, skip: jest.Mock, getManyAndCount: jest.Mock }
  let tokens: { revokeAll: jest.Mock }

  beforeEach(async () => {
    rows = [42, 99].map(id => Object.assign(new MemberEntity(), {
      id,
      phone: id === 42 ? '+8613800138000' : '+8613900139000',
      nickname: `Member ${id}`,
      email: null,
      avatar: null,
      parentId: 7,
      inviteCode: id === 42 ? 'abcdef0123456789' : 'fedcba9876543210',
      status: MemberStatus.Enabled,
      createdAt: new Date('2026-10-27T01:00:00Z'),
      updatedAt: new Date('2026-10-27T01:00:00Z'),
      phoneVerifiedAt: new Date(),
      accessTokens: [{ tokenHash: 'secret', refreshTokens: [{ tokenHash: 'refresh-secret' }] }],
      identities: [{ openid: 'secret-openid', unionid: 'secret-unionid' }],
      parent: { id: 7, phone: 'private-parent-phone' },
      children: [{ id: 100 }],
    }))
    sessions = [42, 42, 99]
    let take = 10
    let skip = 0
    query = {
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn((value) => {
        take = value
        return query
      }),
      skip: jest.fn((value) => {
        skip = value
        return query
      }),
      getManyAndCount: jest.fn(async () => [rows.slice(skip, skip + take), rows.length]),
    }
    repository = {
      findOne: jest.fn(async ({ where }) => rows.find(member => member.id === where.id) ?? null),
      update: jest.fn(async (id, values) => {
        const row = rows.find(member => member.id === id)
        if (row)
          Object.assign(row, values)
        return { affected: row ? 1 : 0 }
      }),
      createQueryBuilder: jest.fn(() => query),
    }
    tokens = {
      revokeAll: jest.fn(async (id) => {
        expect(rows.find(member => member.id === id)?.status).not.toBe(MemberStatus.Enabled)
        sessions = sessions.filter(memberId => memberId !== id)
      }),
    }
    service = new MemberService(repository as unknown as Repository<MemberEntity>)
    const module = await Test.createTestingModule({
      controllers: [MemberProfileController, MemberController],
      providers: [
        { provide: MemberService, useValue: service },
        { provide: MemberTokenService, useValue: tokens },
        { provide: APP_GUARD, useClass: MemberRequestGuard },
      ],
    }).compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    app.useGlobalPipes(new ValidationPipe({
      transform: true,
      whitelist: true,
      transformOptions: { enableImplicitConversion: true },
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      stopAtFirstError: true,
      exceptionFactory: errors => new UnprocessableEntityException(errors.map((error) => {
        const rule = Object.keys(error.constraints!)[0]
        return error.constraints![rule]
      })[0]),
    }))
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterEach(async () => app?.close())

  it('reads only request.member profile even when a different admin user and query ID exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/member/profile?id=99' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: 42, nickname: 'Member 42', phone: '+8613800138000' })
    expect(Object.keys(response.json()).sort()).toEqual(['avatar', 'createdAt', 'email', 'id', 'inviteCode', 'nickname', 'parentId', 'phone', 'status', 'updatedAt'])
  })

  it('updates only the authenticated member profile', async () => {
    const response = await app.inject({ method: 'PUT', url: '/member/profile', payload: { nickname: 'Updated', email: 'member@example.com', avatar: null } })
    expect(response.statusCode).toBe(200)
    expect(rows[0]).toMatchObject({ nickname: 'Updated', email: 'member@example.com', avatar: null, parentId: 7 })
    expect(rows[1].nickname).toBe('Member 99')
  })

  it.each(['id', 'parentId', 'phone', 'inviteCode', 'status'])('strips crafted profile %s while preserving immutable fields', async (field) => {
    const response = await app.inject({ method: 'PUT', url: '/member/profile', payload: { nickname: 'Tampered', [field]: 99 } })
    expect(response.statusCode).toBe(200)
    expect(rows[0]).toMatchObject({ id: 42, nickname: 'Tampered', parentId: 7, phone: '+8613800138000', inviteCode: 'abcdef0123456789', status: MemberStatus.Enabled })
    expect(repository.update).toHaveBeenCalledWith(42, { nickname: 'Tampered' })
    expect(rows[1].nickname).toBe('Member 99')
  })

  it('allowlists mutable fields even when the profile service is called without validation', async () => {
    await service.updateProfile(42, { nickname: 'Safe', parentId: 99, phone: 'changed', inviteCode: 'changed', status: MemberStatus.Disable } as any)
    expect(rows[0]).toMatchObject({ nickname: 'Safe', parentId: 7, phone: '+8613800138000', inviteCode: 'abcdef0123456789', status: MemberStatus.Enabled })
  })

  it('returns only the current member invite code and encoded relative registration link', async () => {
    const response = await app.inject({ method: 'GET', url: '/member/invite?id=99' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ inviteCode: 'abcdef0123456789', inviteLink: '/member/auth/register?inviteCode=abcdef0123456789' })
  })

  it('marks every self-service endpoint as member-only and keeps exact admin permissions', () => {
    expect(Reflect.getMetadata(AUTH_ROUTE_KEY, MemberProfileController)).toBe('member')
    expect(Reflect.getMetadata('swagger/apiSecurity', MemberProfileController)).toEqual([{ auth: [] }])
    expect(Reflect.getMetadata(PATH_METADATA, MemberController)).toBe('members')
    expect(Reflect.getMetadata(AUTH_ROUTE_KEY, MemberController)).toBeUndefined()
    for (const [method, permission] of [['list', 'member:list'], ['read', 'member:read'], ['updateStatus', 'member:update-status']]) {
      const handler = MemberController.prototype[method]
      expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toBe(permission)
      expect(Reflect.getMetadata(AUTH_ROUTE_KEY, handler)).toBeUndefined()
    }
  })

  it('paginates admin results using the shared metadata and explicit safe fields', async () => {
    const response = await app.inject({ method: 'GET', url: '/members?page=2&pageSize=1&field=accessTokens&order=asc' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ items: [{ id: 99 }], meta: { itemCount: 1, totalItems: 2, itemsPerPage: 1, totalPages: 2, currentPage: 2 } })
    expect(Object.keys(response.json().items[0]).sort()).toEqual(['avatar', 'createdAt', 'email', 'id', 'inviteCode', 'nickname', 'parentId', 'phone', 'status', 'updatedAt'])
    expect(query.select).toHaveBeenCalledWith(['member.id', 'member.createdAt', 'member.updatedAt', 'member.parentId', 'member.inviteCode', 'member.phone', 'member.email', 'member.nickname', 'member.avatar', 'member.status'])
    expect(query.orderBy).toHaveBeenCalledWith('member.id', 'DESC')
  })

  it('reads disabled members for admins without exposing identity or token relations', async () => {
    rows[0].status = MemberStatus.Disable
    const response = await app.inject({ method: 'GET', url: '/members/42' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: 42, status: MemberStatus.Disable, parentId: 7 })
    expect(response.body).not.toMatch(/secret|accessTokens|identities|private-parent-phone/)
  })

  it('returns 404 for missing member reads and status updates without revoking sessions', async () => {
    expect((await app.inject({ method: 'GET', url: '/members/999' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PUT', url: '/members/999/status', payload: { status: MemberStatus.Disable } })).statusCode).toBe(404)
    expect(tokens.revokeAll).not.toHaveBeenCalled()
  })

  it('revokes all sessions after disabling while preserving the invitation chain and other member sessions', async () => {
    const response = await app.inject({ method: 'PUT', url: '/members/42/status', payload: { status: MemberStatus.Disable } })
    expect(response.statusCode).toBe(200)
    expect(rows[0]).toMatchObject({ status: MemberStatus.Disable, parentId: 7, inviteCode: 'abcdef0123456789' })
    expect(sessions).toEqual([99])
  })

  it('revokes sessions when cancelling a member', async () => {
    const response = await app.inject({ method: 'PUT', url: '/members/42/status', payload: { status: MemberStatus.Cancelled } })
    expect(response.statusCode).toBe(200)
    expect(sessions).toEqual([99])
  })

  it('does not revoke sessions when enabling a member', async () => {
    const response = await app.inject({ method: 'PUT', url: '/members/42/status', payload: { status: MemberStatus.Enabled } })
    expect(response.statusCode).toBe(200)
    expect(tokens.revokeAll).not.toHaveBeenCalled()
  })

  it('rejects invalid admin status with production validation', async () => {
    const payload = { status: 9 }
    const response = await app.inject({ method: 'PUT', url: '/members/42/status', payload })
    expect(response.statusCode).toBe(422)
    expect(rows[0]).toMatchObject({ status: MemberStatus.Enabled, parentId: 7, inviteCode: 'abcdef0123456789' })
    expect(sessions).toEqual([42, 42, 99])
  })

  it.each(['id', 'parentId', 'phone', 'inviteCode'])('strips crafted admin %s while applying the authorized status change', async (field) => {
    const response = await app.inject({ method: 'PUT', url: '/members/42/status', payload: { status: 0, [field]: 99 } })
    expect(response.statusCode).toBe(200)
    expect(rows[0]).toMatchObject({ id: 42, status: MemberStatus.Disable, parentId: 7, phone: '+8613800138000', inviteCode: 'abcdef0123456789' })
    expect(repository.update).toHaveBeenCalledWith(42, { status: MemberStatus.Disable })
    expect(sessions).toEqual([99])
  })

  it('does not revoke sessions after a failed database update', async () => {
    repository.update.mockRejectedValueOnce(new NotFoundException())
    expect((await app.inject({ method: 'PUT', url: '/members/42/status', payload: { status: MemberStatus.Disable } })).statusCode).toBe(404)
    expect(tokens.revokeAll).not.toHaveBeenCalled()
  })

  it('registers both controllers through MemberModule with its exported auth dependency', async () => {
    @Module({ providers: [{ provide: MemberTokenService, useValue: tokens }], exports: [MemberTokenService] })
    class TestMemberAuthModule {}

    const module = await Test.createTestingModule({ imports: [MemberModule] })
      .overrideModule(MemberAuthModule)
      .useModule(TestMemberAuthModule)
      .overrideProvider(getRepositoryToken(MemberEntity))
      .useValue(repository)
      .compile()
    expect(module.get(MemberController)).toBeInstanceOf(MemberController)
    expect(module.get(MemberProfileController)).toBeInstanceOf(MemberProfileController)
    expect(module.get(MemberService)).toBeInstanceOf(MemberService)
    await module.close()
  })
})
