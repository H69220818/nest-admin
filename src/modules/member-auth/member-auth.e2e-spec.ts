import { createHash } from 'node:crypto'

import { Controller, Get, Global, Module, Post, Req, SetMetadata, ValidationPipe } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { EntityManager, Repository } from 'typeorm'

import { REDIS_CLIENT } from '~/common/decorators/inject-redis.decorator'
import { AppConfig, appCorsOptions, SecurityConfig } from '~/config'
import { MemberAuthConfig } from '~/config/member-auth.config'
import { PERMISSION_KEY } from '~/modules/auth/auth.constant'
import { AuthService } from '~/modules/auth/auth.service'
import { Public } from '~/modules/auth/decorators/public.decorator'
import { JwtAuthGuard } from '~/modules/auth/guards/jwt-auth.guard'
import { RbacGuard } from '~/modules/auth/guards/rbac.guard'
import { TokenService } from '~/modules/auth/services/token.service'
import { JwtStrategy } from '~/modules/auth/strategies/jwt.strategy'
import { MemberStatus } from '~/modules/member/member.constant'
import { MemberEntity } from '~/modules/member/member.entity'
import { RoleService } from '~/modules/system/role/role.service'
import { UserService } from '~/modules/user/user.service'

import { MemberAccessTokenEntity } from './entities/member-access-token.entity'
import { MemberRefreshTokenEntity } from './entities/member-refresh-token.entity'
import { MemberAuthModule } from './member-auth.module'
import { MemberTokenService } from './services/member-token.service'

const config = {
  accessSecret: 'member-access-secret-at-least-32-characters',
  refreshSecret: 'member-refresh-secret-at-least-32-characters',
  accessExpire: 900,
  refreshExpire: 2592000,
}
const adminSecret = 'admin-secret-independent-of-member-secrets'
const phone = '+8613800138000'

// Member guards, JWTs and business services are real; infrastructure and unrelated admin services are substituted.
class AuthStore {
  members: MemberEntity[] = []
  access: MemberAccessTokenEntity[] = []
  refresh: MemberRefreshTokenEntity[] = []
  codes = new Map<string, string>()

  private rows(target: unknown): any[] {
    return target === MemberEntity ? this.members : target === MemberAccessTokenEntity ? this.access : this.refresh
  }

  private matches(row: any, where: object): boolean {
    return Object.entries(where).every(([key, value]) => row[key] === value)
  }

  manager = {
    transaction: async <T>(callback: (manager: EntityManager) => Promise<T>) => callback(this.manager as EntityManager),
    create: (Target: any, input: object) => Object.assign(new Target(), input),
    findOneBy: async (target: unknown, where: object) => this.rows(target).find(row => this.matches(row, where)) ?? null,
    findOne: async (target: unknown, options: any) => this.rows(target).find(row => this.matches(row, options.where)) ?? null,
    save: async (target: any, input?: any) => {
      const row = input ?? target
      const table = this.rows(input ? target : row.constructor)
      row.id ??= table.length + 1
      const index = table.findIndex(existing => existing.id === row.id)
      if (index < 0)
        table.push(row)
      else
        table[index] = row
      return row
    },
    update: async (target: unknown, where: object, values: object) => {
      for (const row of this.rows(target).filter(row => this.matches(row, where)))
        Object.assign(row, values)
      return { affected: 1 }
    },
  } as unknown as EntityManager

  repository = {
    findOneBy: (where: object) => this.manager.findOneBy(MemberEntity, where),
  } as Repository<MemberEntity>

  redis = {
    get: async () => null,
    eval: async (_script: string, keyCount: number, ...args: (string | number)[]) => {
      const key = String(args[0])
      const digest = String(args[keyCount])
      if (keyCount === 1) {
        if (this.codes.get(key) === digest)
          this.codes.delete(key)
        return 1
      }
      if (keyCount === 6) {
        if (args[keyCount + 1] === '1')
          this.codes.set(key, digest)
        return 1
      }
      if (this.codes.get(key) !== digest)
        return 0
      this.codes.delete(key)
      return 1
    },
  }

  seedCode(purpose: 'register' | 'login', code = '123456', targetPhone = phone): void {
    this.codes.set(`member:auth:sms:${purpose}:${targetPhone}:code`, createHash('sha256').update(`${targetPhone}:${purpose}:${code}`).digest('hex'))
  }

  addMember(): MemberEntity {
    const member = Object.assign(new MemberEntity(), { id: this.members.length + 1, phone, status: MemberStatus.Enabled })
    this.members.push(member)
    return member
  }
}

@Global()
@Module({})
class TestPersistenceModule {}

@Public()
@Controller('auth')
class LegacyAdminLoginController {
  @Post('login')
  login() {
    return { reached: true }
  }
}

@Controller('probe')
class RoutingProbeController {
  @SetMetadata('__auth_route__', 'member')
  @Get('member')
  member(@Req() request: any) {
    return { member: request.member, adminUser: request.user ?? null }
  }

  @SetMetadata('__auth_route__', 'member')
  @Public()
  @Get('member-with-public')
  memberWithLegacyPublic() {
    return { reached: true }
  }

  @SetMetadata('__auth_route__', 'member')
  @Post('member-write')
  memberWrite() {
    return { reached: true }
  }

  @SetMetadata('__auth_route__', 'public')
  @Post('public')
  publicAuth() {
    return { reached: true }
  }

  @Get('admin')
  admin(@Req() request: any) {
    return { uid: request.user.uid, roles: request.user.roles }
  }

  @SetMetadata('__auth_route__', 'admin')
  @SetMetadata(PERMISSION_KEY, 'protected:admin')
  @Public()
  @Get('explicit-admin')
  explicitAdmin() {
    return { reached: true }
  }
}

describe('member authentication HTTP routing', () => {
  let app: NestFastifyApplication
  let store: AuthStore
  let tokens: MemberTokenService
  let adminToken: string
  let adminRoles: string[]
  let passwordVersion: string
  const previousDemo = process.env.IS_DEMO

  beforeEach(async () => {
    process.env.IS_DEMO = 'false'
    store = new AuthStore()
    adminRoles = ['admin']
    passwordVersion = '1'
    const jwt = new JwtService({ secret: adminSecret })
    adminToken = await jwt.signAsync({ uid: 11, pv: 1, roles: ['admin'] }, { expiresIn: 900 })
    const module = await Test.createTestingModule({
      imports: [
        MemberAuthModule,
        {
          module: TestPersistenceModule,
          providers: [
            { provide: EntityManager, useValue: store.manager },
            { provide: REDIS_CLIENT, useValue: store.redis },
          ],
          exports: [EntityManager, REDIS_CLIENT],
        },
      ],
      controllers: [RoutingProbeController, LegacyAdminLoginController],
      providers: [
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RbacGuard },
        { provide: AppConfig.KEY, useValue: { multiDeviceLogin: true } },
        { provide: SecurityConfig.KEY, useValue: { jwtSecret: adminSecret } },
        { provide: REDIS_CLIENT, useValue: store.redis },
        { provide: UserService, useValue: { findUserById: async () => ({ id: 11 }) } },
        { provide: RoleService, useValue: { getRoleValuesByUser: async () => adminRoles } },
        { provide: AuthService, useValue: {
          getPasswordVersionByUid: async () => passwordVersion,
          getRoleValuesByUid: async () => adminRoles,
          getPermissionsCache: async () => [],
        } },
        { provide: TokenService, useValue: {
          hasIssuedAccessToken: async (token: string) => token === adminToken,
          checkAccessToken: async () => false,
        } },
      ],
    })
      .overrideProvider(MemberAuthConfig.KEY)
      .useValue(config)
      .overrideProvider(getRepositoryToken(MemberEntity))
      .useValue(store.repository)
      .overrideProvider(getRepositoryToken(MemberAccessTokenEntity))
      .useValue({})
      .overrideProvider(getRepositoryToken(MemberRefreshTokenEntity))
      .useValue({})
      .compile()
    tokens = module.get(MemberTokenService)
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    app.enableCors(appCorsOptions)
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterEach(async () => {
    await app?.close()
    if (previousDemo === undefined)
      delete process.env.IS_DEMO
    else
      process.env.IS_DEMO = previousDemo
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  it('allows browser SMS preflights with device metadata', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/member/auth/sms/register',
      headers: {
        'origin': 'https://member.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-device-id',
      },
    })
    expect(response.statusCode).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('*')
    expect(String(response.headers['access-control-allow-methods']).split(/,\s*/)).toContain('POST')
    expect(String(response.headers['access-control-allow-headers']).toLowerCase().split(/,\s*/)).toEqual(
      expect.arrayContaining(['content-type', 'x-device-id']),
    )
  })

  it('authenticates persisted member tokens exclusively into request.member', async () => {
    const pair = await tokens.issue(store.addMember().id)
    const response = await app.inject({ url: '/probe/member', headers: bearer(pair.accessToken) })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ member: { sub: '1', aud: 'member' }, adminUser: null })
  })

  it('cannot bypass a member guard with legacy Public metadata', async () => {
    const response = await app.inject({ url: '/probe/member-with-public' })
    expect(response.statusCode).toBe(401)
  })

  it('cannot bypass explicit admin authentication with legacy Public metadata', async () => {
    const response = await app.inject({ url: '/probe/explicit-admin' })
    expect(response.statusCode).toBe(401)
  })

  it('allows public auth mutations in demo mode', async () => {
    process.env.IS_DEMO = 'true'
    const response = await app.inject({ method: 'POST', url: '/probe/public' })
    expect(response.statusCode).toBe(201)
  })

  it('preserves the legacy public admin login exemption in demo mode', async () => {
    process.env.IS_DEMO = 'true'
    const response = await app.inject({ method: 'POST', url: '/auth/login' })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ reached: true })
  })

  it('does not bypass admin permissions with legacy Public metadata', async () => {
    adminRoles = ['operator']
    const response = await app.inject({ url: '/probe/explicit-admin', headers: bearer(adminToken) })
    expect(response.json()).toMatchObject({ code: '1102' })
  })

  it('keeps protected member mutations subject to demo mode policy', async () => {
    process.env.IS_DEMO = 'true'
    const pair = await tokens.issue(store.addMember().id)
    const response = await app.inject({ method: 'POST', url: '/probe/member-write', headers: bearer(pair.accessToken) })
    expect(response.statusCode).toBe(403)
  })

  it('rejects admin tokens on member routes', async () => {
    const response = await app.inject({ url: '/probe/member', headers: bearer(adminToken) })
    expect(response.statusCode).toBe(401)
  })

  it('rejects member tokens on default admin routes', async () => {
    const pair = await tokens.issue(store.addMember().id)
    const response = await app.inject({ url: '/probe/admin', headers: bearer(pair.accessToken) })
    expect(response.json()).toMatchObject({ code: '1101' })
  })

  it('rejects tokens once the member is disabled', async () => {
    const member = store.addMember()
    const pair = await tokens.issue(member.id)
    member.status = MemberStatus.Disable
    const response = await app.inject({ url: '/probe/member', headers: bearer(pair.accessToken) })
    expect(response.statusCode).toBe(401)
  })

  it('retains issued-token, password-version and current-role checks for unmarked admin routes', async () => {
    adminRoles = ['operator']
    const valid = await app.inject({ url: '/probe/admin', headers: bearer(adminToken) })
    expect(valid.json()).toEqual({ uid: 11, roles: ['operator'] })
    passwordVersion = '2'
    const stale = await app.inject({ url: '/probe/admin', headers: bearer(adminToken) })
    expect(stale.json()).toMatchObject({ code: '1101' })
    passwordVersion = '1'
    const forged = await new JwtService({ secret: adminSecret }).signAsync({ uid: 11, pv: 1 })
    const unissued = await app.inject({ url: '/probe/admin', headers: bearer(forged) })
    expect(unissued.json()).toMatchObject({ code: '1101' })
  })

  it('registers explicitly and issues a usable member session in demo mode', async () => {
    process.env.IS_DEMO = 'true'
    store.seedCode('register')
    const response = await app.inject({ method: 'POST', url: '/member/auth/register', payload: { phone, code: '123456' } })
    expect(response.statusCode).toBe(201)
    expect(store.members).toHaveLength(1)
    await expect(tokens.verifyAccess(response.json().accessToken)).resolves.toMatchObject({ sub: '1' })
    expect(response.json().refreshToken).toMatch(/^[\w-]{64}$/)
  })

  it('fails unknown-phone login without silently registering a member', async () => {
    store.seedCode('login')
    const response = await app.inject({ method: 'POST', url: '/member/auth/login', payload: { phone, code: '123456' } })
    expect(response.json()).toMatchObject({ code: '2002' })
    expect(store.members).toHaveLength(0)
    expect(store.access).toHaveLength(0)
  })

  it('logs in and rotates a refresh token in demo mode, invalidating the old access token', async () => {
    process.env.IS_DEMO = 'true'
    store.addMember()
    store.seedCode('login')
    const login = await app.inject({ method: 'POST', url: '/member/auth/login', payload: { phone, code: '123456' } })
    expect(login.statusCode).toBe(201)
    const refresh = await app.inject({ method: 'POST', url: '/member/auth/refresh', payload: { refreshToken: login.json().refreshToken } })
    expect(refresh.statusCode).toBe(201)
    await expect(tokens.verifyAccess(refresh.json().accessToken)).resolves.toMatchObject({ sub: '1' })
    await expect(tokens.verifyAccess(login.json().accessToken)).rejects.toThrow()
  })

  it('logs out only the current session and prevents refresh of that session', async () => {
    const id = store.addMember().id
    const first = await tokens.issue(id)
    const second = await tokens.issue(id)
    const logout = await app.inject({ method: 'POST', url: '/member/auth/logout', headers: bearer(first.accessToken) })
    expect(logout.statusCode).toBe(201)
    await expect(tokens.verifyAccess(first.accessToken)).rejects.toThrow()
    await expect(tokens.rotate(first.refreshToken)).rejects.toThrow()
    await expect(tokens.verifyAccess(second.accessToken)).resolves.toMatchObject({ sub: '1' })
  })

  it('rejects malformed refresh input without reaching token rotation', async () => {
    const response = await app.inject({ method: 'POST', url: '/member/auth/refresh', payload: { refreshToken: 123 } })
    expect(response.statusCode).toBe(400)
  })

  it('does not expose SMS codes for protected phone unbinding', async () => {
    const response = await app.inject({ method: 'POST', url: '/member/auth/sms/unbind', payload: { phone } })
    expect(response.statusCode).toBe(400)
    expect(store.codes.size).toBe(0)
  })

  it('fails closed and discards undelivered registration codes without an SMS provider', async () => {
    const response = await app.inject({ method: 'POST', url: '/member/auth/sms/register', payload: { phone } })
    expect(response.json()).toMatchObject({ code: '2007' })
    expect(store.codes.size).toBe(0)
    expect(store.members).toHaveLength(0)
  })
})
