import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { HttpService } from '@nestjs/axios'
import { Global, HttpStatus, Logger, Module, UnprocessableEntityException, ValidationPipe } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import axios from 'axios'
import Redis from 'ioredis'
import { Connection, createConnection } from 'mysql2/promise'
import { DataSource, EntityManager } from 'typeorm'

import { REDIS_CLIENT } from '~/common/decorators/inject-redis.decorator'
import { AppConfig, SecurityConfig } from '~/config'
import { MemberAuthConfig } from '~/config/member-auth.config'
import { IWechatConfig, WechatConfig } from '~/config/wechat.config'
import { genAuthPVKey } from '~/helper/genRedisKey'
import { InitData1707996695540 } from '~/migrations/1707996695540-initData'
import { UpdateTable2001717007831711 } from '~/migrations/1717007831711-update-table_2_0_0'
import { AddMemberDomain1793080800000 } from '~/migrations/1793080800000-add-member-domain'
import { AuthService } from '~/modules/auth/auth.service'
import { JwtAuthGuard } from '~/modules/auth/guards/jwt-auth.guard'
import { RbacGuard } from '~/modules/auth/guards/rbac.guard'
import { TokenService } from '~/modules/auth/services/token.service'
import { JwtStrategy } from '~/modules/auth/strategies/jwt.strategy'
import { MemberAccessTokenEntity } from '~/modules/member-auth/entities/member-access-token.entity'
import { MemberRefreshTokenEntity } from '~/modules/member-auth/entities/member-refresh-token.entity'
import { SMS_SENDER, SmsPurpose, SmsSender } from '~/modules/member-auth/member-auth.constant'
import { MemberAuthModule } from '~/modules/member-auth/member-auth.module'
import { MemberTokenPair, MemberTokenService } from '~/modules/member-auth/services/member-token.service'
import { MemberIdentityEntity } from '~/modules/member-social/member-identity.entity'
import { MemberSocialModule } from '~/modules/member-social/member-social.module'
import { MenuEntity } from '~/modules/system/menu/menu.entity'
import { MenuService } from '~/modules/system/menu/menu.service'
import { RoleEntity } from '~/modules/system/role/role.entity'
import { RoleService } from '~/modules/system/role/role.service'
import { UserEntity } from '~/modules/user/user.entity'
import { UserService } from '~/modules/user/user.service'

import { MemberTeamService } from './member-team.service'
import { MemberStatus } from './member.constant'
import { MemberEntity } from './member.entity'
import { MemberService } from './member.service'

@Global()
@Module({})
class AcceptanceInfrastructureModule {}

// Explicit opt-in; never load the developer's database or Redis settings.
const integration = process.env.MEMBER_INTEGRATION === '1' ? describe : describe.skip

integration('member acceptance with disposable MySQL 8 schema and Redis keys', () => {
  const runId = randomUUID().replace(/-/g, '')
  const schema = `member_acceptance_${runId}`
  const prefix = `${schema}:`
  const memberConfig = {
    accessSecret: 'acceptance-member-access-independent-secret-32-characters',
    refreshSecret: 'acceptance-member-refresh-independent-secret-32-characters',
    accessExpire: 900,
    refreshExpire: 2592000,
  }
  const security = {
    jwtSecret: 'acceptance-admin-access-independent-secret-32-characters',
    jwtExprire: 900,
    refreshSecret: 'acceptance-admin-refresh-independent-secret-32-characters',
    refreshExpire: 2592000,
  }
  const wechat: IWechatConfig = {
    enabled: true,
    mode: 'website',
    appId: 'acceptance-oauth',
    appSecret: 'disposable-oauth-secret',
    callbackUrl: 'https://api.member.example/member/auth/wechat/callback',
    scope: 'snsapi_login',
    returnOrigins: ['https://member.example'],
    stateTtlSeconds: 600,
    httpTimeoutMs: 5000,
    miniapp: { enabled: true, appId: 'acceptance-miniapp', appSecret: 'disposable-miniapp-secret', codeTtlSeconds: 300, httpTimeoutMs: 5000 },
  }
  let server: Connection
  let database: DataSource
  let redis: Redis
  let rawRedis: Redis
  let app: NestFastifyApplication
  let adminToken: string
  let previousDemo: string | undefined
  const deliveries = new Map<string, string>()
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    if (!process.env.MEMBER_TEST_MYSQL_URL || !process.env.MEMBER_TEST_REDIS_URL)
      throw new Error('Set MEMBER_TEST_MYSQL_URL and MEMBER_TEST_REDIS_URL explicitly; see README')
    const mysql = new URL(process.env.MEMBER_TEST_MYSQL_URL)
    if (mysql.protocol !== 'mysql:')
      throw new Error('MEMBER_TEST_MYSQL_URL must use mysql://')
    const options = {
      host: mysql.hostname,
      port: Number(mysql.port || 3306),
      user: decodeURIComponent(mysql.username),
      password: decodeURIComponent(mysql.password),
    }
    server = await createConnection(options)
    const [version] = await server.query('SELECT VERSION() AS version')
    expect((version as { version: string }[])[0].version).toMatch(/^8\./)
    await server.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`)
    database = await new DataSource({
      type: 'mysql',
      host: options.host,
      port: options.port,
      username: options.user,
      password: options.password,
      database: schema,
      entities: [path.join(__dirname, '../**/*.entity.ts')],
      migrations: [InitData1707996695540, UpdateTable2001717007831711, AddMemberDomain1793080800000],
      synchronize: false,
      multipleStatements: true,
    }).initialize()
    expect((await database.runMigrations()).map(migration => migration.name)).toEqual([
      'InitData1707996695540',
      'UpdateTable2001717007831711',
      'AddMemberDomain1793080800000',
    ])
    redis = new Redis(process.env.MEMBER_TEST_REDIS_URL, { keyPrefix: prefix, maxRetriesPerRequest: 1 })
    rawRedis = new Redis(process.env.MEMBER_TEST_REDIS_URL, { maxRetriesPerRequest: 1 })
    await redis.ping()
    previousDemo = process.env.IS_DEMO
    process.env.IS_DEMO = 'false'

    // These are real admin services. Unused admin account-edit/login-log dependencies
    // are absent; authentication, current-role lookup and persisted tokens run normally.
    const roles = new RoleService(database.getRepository(RoleEntity), database.getRepository(MenuEntity), database.manager)
    const users = new UserService(redis, database.getRepository(UserEntity), database.getRepository(RoleEntity), database.manager, undefined, undefined)
    const menus = new MenuService(redis, database.getRepository(MenuEntity), roles, undefined)
    const jwt = new JwtService({ secret: security.jwtSecret, signOptions: { expiresIn: 900 } })
    const adminTokens = new TokenService(jwt, roles, redis, security)
    const auth = new AuthService(redis, menus, roles, users, undefined, adminTokens, security, { multiDeviceLogin: true } as any)
    adminToken = (await adminTokens.generateAccessToken(1, ['admin'])).accessToken
    await redis.set(genAuthPVKey(1), '1')

    // Mock only external delivery and HTTP transport; SMS codes/Lua, OAuth state,
    // WeChat normalization, transactions, guards and token services stay real.
    const sender: SmsSender = {
      sendCode: async (phone, purpose, code) => {
        deliveries.set(`${phone}:${purpose}`, code)
      },
    }
    const http = axios.create({
      adapter: async (config) => {
        let data: Record<string, unknown>
        if (config.url === 'https://api.weixin.qq.com/sns/oauth2/access_token') {
          expect(config.params).toMatchObject({ appid: 'acceptance-oauth', secret: 'disposable-oauth-secret', grant_type: 'authorization_code' })
          if (!['oauth-bind-b', 'oauth-login-b', 'oauth-disabled-b'].includes(config.params.code))
            throw new Error('Unexpected OAuth code')
          data = { openid: 'oauth-subject-b', unionid: 'wechat-union-b', access_token: 'external-access', scope: 'snsapi_login' }
        }
        else if (config.url === 'https://api.weixin.qq.com/sns/userinfo') {
          expect(config.params).toMatchObject({ access_token: 'external-access', openid: 'oauth-subject-b' })
          data = { openid: 'oauth-subject-b', unionid: 'wechat-union-b', nickname: 'WeChat B', headimgurl: 'https://member.example/avatar.png' }
        }
        else if (config.url === 'https://api.weixin.qq.com/sns/jscode2session') {
          expect(config.params).toMatchObject({ appid: 'acceptance-miniapp', secret: 'disposable-miniapp-secret', grant_type: 'authorization_code' })
          if (!['mini-bind-b', 'mini-login-b', 'mini-disabled-b', 'mini-unknown'].includes(config.params.js_code))
            throw new Error('Unexpected miniapp code')
          data = { openid: config.params.js_code === 'mini-unknown' ? 'unknown' : 'mini-subject-b', unionid: 'wechat-union-b', session_key: 'external-session-key' }
        }
        else {
          throw new Error('Unexpected external HTTP request')
        }
        return { data, status: 200, statusText: 'OK', headers: {}, config }
      },
    })
    const module = await Test.createTestingModule({
      imports: [
        MemberAuthModule,
        MemberSocialModule,
        {
          module: AcceptanceInfrastructureModule,
          providers: [
            { provide: DataSource, useValue: database },
            { provide: EntityManager, useValue: database.manager },
            { provide: REDIS_CLIENT, useValue: redis },
          ],
          exports: [DataSource, EntityManager, REDIS_CLIENT],
        },
      ],
      providers: [
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RbacGuard },
        { provide: AppConfig.KEY, useValue: { multiDeviceLogin: true } },
        { provide: SecurityConfig.KEY, useValue: security },
        { provide: AuthService, useValue: auth },
        { provide: TokenService, useValue: adminTokens },
        { provide: UserService, useValue: users },
        { provide: RoleService, useValue: roles },
      ],
    })
      .overrideProvider(MemberAuthConfig.KEY)
      .useValue(memberConfig)
      .overrideProvider(WechatConfig.KEY)
      .useValue(wechat)
      .overrideProvider(HttpService)
      .useValue({ axiosRef: http })
      .overrideProvider(SMS_SENDER)
      .useValue(sender)
      .compile()
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
  }, 60000)

  afterAll(async () => {
    try {
      await app?.close()
      if (database?.isInitialized)
        await database.destroy()
    }
    finally {
      try {
        // SCAN/DEL is scoped to the unpredictable prefix; never FLUSHDB/FLUSHALL.
        if (rawRedis) {
          let cursor = '0'
          do {
            const [next, keys] = await rawRedis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100)
            cursor = next
            if (keys.length)
              await rawRedis.del(...keys)
          } while (cursor !== '0')
          expect(await rawRedis.keys(`${prefix}*`)).toEqual([])
        }
      }
      finally {
        redis?.disconnect()
        rawRedis?.disconnect()
        if (server) {
          await server.query(`DROP DATABASE IF EXISTS \`${schema}\``)
          await server.end()
        }
        if (previousDemo === undefined)
          delete process.env.IS_DEMO
        else
          process.env.IS_DEMO = previousDemo
      }
    }
  }, 30000)

  function barrier() {
    let release!: () => void
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    return { promise, release }
  }

  let raceMember = 0
  async function createRaceMember() {
    const members = app.get(MemberService)
    const member = await database.transaction(manager => members.createRegisteredMember({
      phone: `+861800000${String(++raceMember).padStart(4, '0')}`,
      phoneVerifiedAt: new Date(),
    }, manager))
    const jwt = new JwtService()
    return { member, jwt, tokens: new MemberTokenService(jwt, memberConfig, database.manager, members) }
  }

  it.each([
    ['issue', MemberStatus.Disable],
    ['issue', MemberStatus.Cancelled],
    ['rotate', MemberStatus.Disable],
    ['rotate', MemberStatus.Cancelled],
  ] as const)('serializes a paused %s with status %s so re-enabling never revives credentials', async (operation, status) => {
    const { member, jwt, tokens } = await createRaceMember()
    const existing = await tokens.issue(member.id)
    const otherDevice = await tokens.issue(member.id)
    const paused = barrier()
    const resume = barrier()
    const sign = jwt.signAsync.bind(jwt)
    const signing = jest.spyOn(jwt, 'signAsync').mockImplementation(async (...args) => {
      const value = await sign(...args)
      paused.release()
      await resume.promise
      return value
    })
    const pending = operation === 'issue' ? tokens.issue(member.id) : tokens.rotate(existing.refreshToken)
    await paused.promise
    const transition = { completed: false }
    const disabling = Promise.resolve(app.inject({ method: 'PUT', url: `/members/${member.id}/status`, headers: bearer(adminToken), payload: { status } }))
      .then((response) => {
        transition.completed = true
        return response
      })
    try {
      // Release only after disable commits (the bug) or MySQL reports that it is
      // waiting on the member lock. No timing assumption determines the outcome.
      const deadline = Date.now() + 5000
      while (!transition.completed) {
        const [waiting] = await server.query(`SELECT COUNT(*) AS count
          FROM performance_schema.data_lock_waits w
          JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
          WHERE l.OBJECT_SCHEMA = ? AND l.OBJECT_NAME = 'member'`, [schema])
        if ((waiting as { count: number }[])[0].count > 0)
          break
        if (Date.now() >= deadline)
          throw new Error('Status transition neither completed nor waited on the member lock')
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    }
    finally {
      resume.release()
      await Promise.allSettled([pending, disabling])
      signing.mockRestore()
    }
    const issued = await pending
    expect((await disabling).statusCode).toBe(200)
    expect((await app.inject({ method: 'PUT', url: `/members/${member.id}/status`, headers: bearer(adminToken), payload: { status: MemberStatus.Enabled } })).statusCode).toBe(200)
    for (const pair of [existing, otherDevice, issued]) {
      await expect(tokens.verifyAccess(pair.accessToken)).rejects.toMatchObject({ status: 401 })
      await expect(tokens.rotate(pair.refreshToken)).rejects.toMatchObject({ status: 401 })
    }
    expect((await database.getRepository(MemberAccessTokenEntity).findBy({ memberId: member.id })).every(session => session.revokedAt instanceof Date)).toBe(true)
  }, 15000)

  it.each([MemberStatus.Disable, MemberStatus.Cancelled])('rolls back status %s and session changes when refresh revocation fails', async (status) => {
    const { member, tokens } = await createRaceMember()
    const pair = await tokens.issue(member.id)
    await database.query(`CREATE TRIGGER fail_member_refresh_revoke BEFORE UPDATE ON member_refresh_token
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Injected refresh revocation failure'`)
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    try {
      expect((await app.inject({ method: 'PUT', url: `/members/${member.id}/status`, headers: bearer(adminToken), payload: { status } })).statusCode).toBe(500)
      expect((await database.getRepository(MemberEntity).findOneByOrFail({ id: member.id })).status).toBe(MemberStatus.Enabled)
      await expect(tokens.verifyAccess(pair.accessToken)).resolves.toMatchObject({ sub: String(member.id) })
      expect((await database.getRepository(MemberAccessTokenEntity).findOneByOrFail({ memberId: member.id })).revokedAt).toBeNull()
    }
    finally {
      errorLog.mockRestore()
      await database.query('DROP TRIGGER fail_member_refresh_revoke')
    }
    await expect(tokens.rotate(pair.refreshToken)).resolves.toHaveProperty('accessToken')
  })

  async function sms(phone: string, purpose: SmsPurpose): Promise<string> {
    const response = await app.inject({ method: 'POST', url: `/member/auth/sms/${purpose}`, payload: { phone }, headers: { 'x-device-id': `acceptance-${phone}` } })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ success: true })
    const code = deliveries.get(`${phone}:${purpose}`)
    expect(code).toMatch(/^\d{6}$/)
    return code!
  }

  async function register(phone: string, inviteCode?: string): Promise<MemberTokenPair> {
    const code = await sms(phone, 'register')
    const response = await app.inject({ method: 'POST', url: '/member/auth/register', payload: { phone, code, inviteCode } })
    expect(response.statusCode).toBe(201)
    const pair = response.json<MemberTokenPair>()
    expect(pair.accessToken).toBeTruthy()
    return pair
  }

  async function oauthState(intent: 'login' | 'bind', token?: string): Promise<string> {
    const url = intent === 'login' ? '/member/auth/wechat/oauth-url' : '/member/social/wechat-oauth/bind-url'
    const response = await app.inject({ method: 'POST', url, headers: token ? bearer(token) : {}, payload: { returnUrl: 'https://member.example/profile' } })
    expect(response.statusCode).toBe(201)
    return new URL(response.json().authorizationUrl).searchParams.get('state')!
  }

  it('registers A → B → C, authenticates all B channels, blocks replay/audience mixing and revokes every B session without changing ancestry', async () => {
    const existingMemberCount = await database.getRepository(MemberEntity).count()
    const a = await register('+8613800000011')
    const aProfile = (await app.inject({ url: '/member/profile', headers: bearer(a.accessToken) })).json()
    expect(aProfile.parentId).toBeNull()
    const b = await register('+8613800000022', aProfile.inviteCode)
    const bProfile = (await app.inject({ url: '/member/profile', headers: bearer(b.accessToken) })).json()
    const c = await register('+8613800000033', bProfile.inviteCode)
    const cProfile = (await app.inject({ url: '/member/profile', headers: bearer(c.accessToken) })).json()
    expect(bProfile.parentId).toBe(aProfile.id)
    expect(cProfile.parentId).toBe(bProfile.id)
    expect((await app.inject({ method: 'POST', url: '/member/auth/register', payload: { phone: bProfile.phone, code: deliveries.get(`${bProfile.phone}:register`) } })).json()).toMatchObject({ code: '2005' })
    const ancestors = await app.inject({ url: '/member/team/ancestors?maxDepth=100&id=999', headers: bearer(c.accessToken) })
    expect(ancestors.statusCode).toBe(200)
    expect(ancestors.json().map(({ id, level }) => ({ id, level }))).toEqual([{ id: bProfile.id, level: 1 }, { id: aProfile.id, level: 2 }])
    const descendants = await app.inject({ url: '/member/team/descendants?page=1&pageSize=1&maxDepth=100', headers: bearer(a.accessToken) })
    expect(descendants.json()).toMatchObject({ items: [{ id: bProfile.id, level: 1 }], meta: { totalItems: 2, totalPages: 2 } })

    // Observe real Redis resend enforcement, then advance only this disposable key.
    expect((await app.inject({ method: 'POST', url: '/member/auth/sms/login', payload: { phone: bProfile.phone } })).json()).toMatchObject({ code: '2006' })
    await redis.del(`member:auth:sms:limit:phone:${bProfile.phone}:resend`)
    const code = await sms(bProfile.phone, 'login')
    expect((await app.inject({ method: 'POST', url: '/member/auth/register', payload: { phone: bProfile.phone, code } })).json()).toMatchObject({ code: '2005' })
    const phoneLogin = await app.inject({ method: 'POST', url: '/member/auth/login', payload: { phone: bProfile.phone, code } })
    expect(phoneLogin.statusCode).toBe(201)
    const phonePair = phoneLogin.json<MemberTokenPair>()
    expect((await app.inject({ method: 'POST', url: '/member/auth/login', payload: { phone: bProfile.phone, code } })).json()).toMatchObject({ code: '2002' })
    expect((await app.inject({ method: 'POST', url: '/member/auth/register', payload: { phone: bProfile.phone, code } })).json()).toMatchObject({ code: '2005' })

    const bindState = await oauthState('bind', phonePair.accessToken)
    const binding = await app.inject({ url: `/member/auth/wechat/callback?code=oauth-bind-b&state=${bindState}` })
    expect(binding.statusCode).toBe(200)
    expect(binding.json()).toMatchObject({ intent: 'bind', binding: { provider: 'wechat_oauth', tenant: 'acceptance-oauth' } })
    expect((await app.inject({ url: `/member/auth/wechat/callback?code=oauth-bind-b&state=${bindState}` })).statusCode).toBe(400)
    const miniBinding = await app.inject({ method: 'POST', url: '/member/social/wechat-miniapp/bind', headers: bearer(phonePair.accessToken), payload: { code: 'mini-bind-b', memberId: aProfile.id } })
    expect(miniBinding.statusCode).toBe(201)
    expect(miniBinding.json()).toMatchObject({ provider: 'wechat_miniapp', tenant: 'acceptance-miniapp' })
    expect((await database.getRepository(MemberIdentityEntity).find()).map(row => row.memberId)).toEqual([bProfile.id, bProfile.id])
    expect((await app.inject({ method: 'POST', url: '/member/auth/wechat-miniapp', payload: { code: 'mini-bind-b' } })).statusCode).toBe(400)

    const loginState = await oauthState('login')
    const oauthLogin = await app.inject({ url: `/member/auth/wechat/callback?code=oauth-login-b&state=${loginState}` })
    expect(oauthLogin.statusCode).toBe(200)
    const oauthPair = oauthLogin.json<MemberTokenPair>()
    const miniLogin = await app.inject({ method: 'POST', url: '/member/auth/wechat-miniapp', payload: { code: 'mini-login-b' } })
    expect(miniLogin.statusCode).toBe(201)
    const miniPair = miniLogin.json<MemberTokenPair>()
    expect((await app.inject({ method: 'POST', url: '/member/auth/wechat-miniapp', payload: { code: 'mini-login-b' } })).statusCode).toBe(400)
    expect(miniLogin.body).not.toMatch(/external-session-key|openid|unionid/)
    expect((await app.inject({ method: 'POST', url: '/member/auth/wechat-miniapp', payload: { code: 'mini-unknown' } })).statusCode).toBe(401)
    expect(await database.getRepository(MemberEntity).count()).toBe(existingMemberCount + 3)

    const bPairs = [b, phonePair, oauthPair, miniPair]
    for (const pair of bPairs) {
      const profile = await app.inject({ url: '/member/profile', headers: bearer(pair.accessToken) })
      expect(profile.statusCode).toBe(200)
      expect(profile.json().id).toBe(bProfile.id)
      expect((await app.inject({ url: '/members', headers: bearer(pair.accessToken) })).json()).toMatchObject({ code: '1101' })
    }
    expect((await app.inject({ url: '/member/profile', headers: bearer(adminToken) })).statusCode).toBe(401)
    expect((await app.inject({ url: '/member/profile', headers: bearer(miniPair.refreshToken) })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/member/auth/refresh', payload: { refreshToken: adminToken } })).statusCode).toBe(422)
    expect((await app.inject({ method: 'POST', url: '/member/auth/refresh', payload: { refreshToken: miniPair.accessToken } })).statusCode).toBe(422)
    expect((await app.inject({ method: 'POST', url: '/member/auth/wechat/oauth-url', payload: { returnUrl: 'https://member.example.evil/profile' } })).statusCode).toBe(400)

    // Reusing an old refresh revokes its whole session, including the rotated pair.
    const rotated = await app.inject({ method: 'POST', url: '/member/auth/refresh', payload: { refreshToken: b.refreshToken } })
    expect(rotated.statusCode).toBe(201)
    expect((await app.inject({ url: '/member/profile', headers: bearer(b.accessToken) })).statusCode).toBe(401)
    expect((await app.inject({ url: '/member/profile', headers: bearer(rotated.json().accessToken) })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/member/auth/refresh', payload: { refreshToken: b.refreshToken } })).statusCode).toBe(401)
    expect((await app.inject({ url: '/member/profile', headers: bearer(rotated.json().accessToken) })).statusCode).toBe(401)
    bPairs.push(rotated.json())

    const disable = await app.inject({ method: 'PUT', url: `/members/${bProfile.id}/status`, headers: bearer(adminToken), payload: { status: 0, parentId: cProfile.id } })
    expect(disable.statusCode).toBe(200)
    const sessions = await database.getRepository(MemberAccessTokenEntity).findBy({ memberId: bProfile.id })
    expect(sessions).toHaveLength(4)
    for (const session of sessions) {
      expect(session.revokedAt).toBeInstanceOf(Date)
      const refreshTokens = await database.getRepository(MemberRefreshTokenEntity).findBy({ accessTokenId: session.id })
      expect(refreshTokens.length).toBeGreaterThan(0)
      expect(refreshTokens.every(token => token.revokedAt instanceof Date)).toBe(true)
    }
    for (const pair of bPairs) {
      expect((await app.inject({ url: '/member/profile', headers: bearer(pair.accessToken) })).statusCode).toBe(401)
      expect((await app.inject({ method: 'POST', url: '/member/auth/refresh', payload: { refreshToken: pair.refreshToken } })).statusCode).toBe(401)
    }
    expect((await app.inject({ method: 'POST', url: '/member/auth/wechat-miniapp', payload: { code: 'mini-disabled-b' } })).statusCode).toBe(401)
    const disabledState = await oauthState('login')
    expect((await app.inject({ url: `/member/auth/wechat/callback?code=oauth-disabled-b&state=${disabledState}` })).statusCode).toBe(401)
    expect(await database.getRepository(MemberEntity).findOneBy({ id: bProfile.id })).toMatchObject({ status: MemberStatus.Disable, parentId: aProfile.id, inviteCode: bProfile.inviteCode })
    expect(await database.getRepository(MemberEntity).findOneBy({ id: cProfile.id })).toMatchObject({ parentId: bProfile.id })
    expect((await app.inject({ url: '/member/team/ancestors', headers: bearer(c.accessToken) })).json().map(({ id, level }) => ({ id, level }))).toEqual([{ id: bProfile.id, level: 1 }, { id: aProfile.id, level: 2 }])
    expect((await app.inject({ url: '/member/profile', headers: bearer(a.accessToken) })).statusCode).toBe(200)
  }, 30000)

  it('executes bounded recursive traversal, stable pages and cycle/self protection on MySQL 8', async () => {
    const members = database.getRepository(MemberEntity)
    const chain: MemberEntity[] = []
    for (let index = 0; index < 4; index++) {
      chain.push(await members.save(members.create({
        phone: `+861390000000${index}`,
        phoneVerifiedAt: new Date(),
        inviteCode: `fixture00000000${index}`,
        parentId: chain.at(-1)?.id ?? null,
        status: MemberStatus.Enabled,
      })))
    }
    const teams = new MemberTeamService(members)
    expect((await teams.listAncestors(chain[3].id, 100)).map(row => row.level)).toEqual([1, 2, 3])
    expect((await teams.listDescendants(chain[0].id, 2, { page: 2, pageSize: 1 })).items).toMatchObject([{ id: chain[2].id, level: 2 }])
    expect((await teams.listDescendants(chain[0].id, 2, { page: 99, pageSize: 1 })).meta).toMatchObject({ totalItems: 2, itemCount: 0 })
    expect((await teams.listDirect(chain[0].id, {})).items).toMatchObject([{ id: chain[1].id, level: 1 }])
    await members.update(chain[0].id, { parentId: chain[3].id })
    expect((await teams.listAncestors(chain[3].id, 100)).map(row => row.id)).toEqual([chain[2].id, chain[1].id, chain[0].id])
    expect((await teams.listDescendants(chain[0].id, 100)).items.map(row => row.id)).toEqual([chain[1].id, chain[2].id, chain[3].id])
    await members.update(chain[0].id, { parentId: chain[0].id })
    expect(await teams.listAncestors(chain[0].id, 100)).toEqual([])
    expect((await teams.listDescendants(chain[0].id, 100)).items.map(row => row.id)).toEqual([chain[1].id, chain[2].id, chain[3].id])
  })
})
