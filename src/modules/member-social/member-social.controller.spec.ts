import { HttpStatus, UnprocessableEntityException, ValidationPipe } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { Test } from '@nestjs/testing'

import { REDIS_CLIENT } from '~/common/decorators/inject-redis.decorator'
import { AppConfig } from '~/config/app.config'
import { MemberAuthConfig } from '~/config/member-auth.config'
import { AuthService } from '~/modules/auth/auth.service'
import { JwtAuthGuard } from '~/modules/auth/guards/jwt-auth.guard'
import { TokenService } from '~/modules/auth/services/token.service'
import { MemberJwtAuthGuard } from '~/modules/member-auth/member-jwt-auth.guard'
import { MemberJwtStrategy } from '~/modules/member-auth/member-jwt.strategy'
import { MemberTokenService } from '~/modules/member-auth/services/member-token.service'

import { MemberSocialController } from './member-social.controller'
import { MemberSocialService } from './member-social.service'

describe('member social HTTP boundary', () => {
  let app: NestFastifyApplication
  let service: Record<string, jest.Mock>
  let memberToken: string
  let previousDemo: string | undefined
  const state = 'a'.repeat(64)
  const secret = 'member-access-independent-secret-at-least-32-characters'

  beforeEach(async () => {
    previousDemo = process.env.IS_DEMO
    process.env.IS_DEMO = 'false'
    service = {
      createOAuthState: jest.fn(async () => ({ authorizationUrl: 'https://open.weixin.qq.com/authorize', expiresIn: 600 })),
      consumeOAuthCallback: jest.fn(async () => ({ intent: 'bind', returnUrl: 'https://member.example/profile', binding: { id: 1 } })),
      listBindings: jest.fn(async () => []),
      sendUnbindCode: jest.fn(async () => ({ success: true })),
      unbindIdentity: jest.fn(async () => undefined),
    }
    const principal = { sub: '42', aud: 'member', tokenType: 'access', sessionId: 'session', pv: 1 }
    memberToken = await new JwtService().signAsync(principal, { secret, expiresIn: 900 })
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [MemberSocialController],
      providers: [
        { provide: MemberSocialService, useValue: service },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        MemberJwtAuthGuard,
        MemberJwtStrategy,
        { provide: MemberAuthConfig.KEY, useValue: { accessSecret: secret } },
        { provide: MemberTokenService, useValue: { verifyAccess: async () => principal } },
        { provide: AppConfig.KEY, useValue: { multiDeviceLogin: true } },
        { provide: AuthService, useValue: {} },
        { provide: TokenService, useValue: {} },
        { provide: REDIS_CLIENT, useValue: {} },
      ],
    }).compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    // These are the production settings from main.ts: unknown fields are stripped, not rejected.
    app.useGlobalPipes(new ValidationPipe({
      transform: true,
      whitelist: true,
      transformOptions: { enableImplicitConversion: true },
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      stopAtFirstError: true,
      exceptionFactory: errors => new UnprocessableEntityException(Object.values(errors[0].constraints!)[0]),
    }))
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

  it.each([
    ['POST', '/member/social/wechat-oauth/bind-url'],
    ['GET', '/member/social'],
    ['POST', '/member/social/unbind-sms'],
    ['DELETE', '/member/social/wechat_oauth'],
  ] as const)('requires member authentication for %s %s', async (method, url) => {
    const response = await app.inject({ method, url })
    expect(response.statusCode).toBe(401)
  })

  it('rejects an administrator token on bind URL creation', async () => {
    const adminToken = await new JwtService().signAsync({ uid: 99, pv: 1 }, { secret: 'independent-admin-secret-at-least-32-characters' })
    const response = await app.inject({ method: 'POST', url: '/member/social/wechat-oauth/bind-url', headers: bearer(adminToken), payload: { returnUrl: 'https://member.example/' } })
    expect(response.statusCode).toBe(401)
    expect(service.createOAuthState).not.toHaveBeenCalled()
  })

  it('uses only request.member when creating bind state despite crafted IDs and intent', async () => {
    const response = await app.inject({ method: 'POST', url: '/member/social/wechat-oauth/bind-url', headers: bearer(memberToken), payload: { returnUrl: 'https://member.example/profile', memberId: 99, intent: 'login', appId: 'evil' } })
    expect(response.statusCode).toBe(201)
    expect(service.createOAuthState).toHaveBeenCalledWith(42, 'bind', 'https://member.example/profile')
  })

  it('allows public login authorization in demo mode and ignores crafted member/intent', async () => {
    process.env.IS_DEMO = 'true'
    const response = await app.inject({ method: 'POST', url: '/member/auth/wechat/oauth-url', payload: { returnUrl: 'https://member.example/', memberId: 99, intent: 'bind' } })
    expect(response.statusCode).toBe(201)
    expect(service.createOAuthState).toHaveBeenCalledWith(undefined, 'login', 'https://member.example/')
  })

  it('passes only code and state to public callback, never client member/return URL', async () => {
    const response = await app.inject({ url: `/member/auth/wechat/callback?code=oauth-code&state=${state}&memberId=99&returnUrl=https://evil.example/&intent=login` })
    expect(response.statusCode).toBe(200)
    expect(service.consumeOAuthCallback).toHaveBeenCalledWith('oauth-code', state)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json().returnUrl).toBe('https://member.example/profile')
  })

  it.each(['?code=oauth-code&state=invalid', `?code=&state=${state}`, `?state=${state}`])('rejects invalid callback input %s', async (query) => {
    const response = await app.inject({ url: `/member/auth/wechat/callback${query}` })
    expect(response.statusCode).toBe(422)
    expect(service.consumeOAuthCallback).not.toHaveBeenCalled()
  })

  it('rejects malformed authorization return URL before creating state', async () => {
    const response = await app.inject({ method: 'POST', url: '/member/auth/wechat/oauth-url', payload: { returnUrl: 123 } })
    expect(response.statusCode).toBe(422)
  })

  it('lists bindings only for the authenticated member', async () => {
    const response = await app.inject({ url: '/member/social?memberId=99', headers: bearer(memberToken) })
    expect(response.statusCode).toBe(200)
    expect(service.listBindings).toHaveBeenCalledWith(42)
  })

  it('cannot choose a different phone or SMS purpose for unbinding', async () => {
    const response = await app.inject({ method: 'POST', url: '/member/social/unbind-sms', headers: { ...bearer(memberToken), 'x-device-id': 'test-device' }, payload: { phone: '+8613999999999', purpose: 'login', memberId: 99 } })
    expect(response.statusCode).toBe(201)
    expect(service.sendUnbindCode).toHaveBeenCalledWith(42, { ip: expect.any(String), deviceId: 'test-device' })
  })

  it('passes unbind confirmation for only the authenticated member', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/member/social/wechat_oauth', headers: bearer(memberToken), payload: { tenant: 'wx-app', code: '123456', memberId: 99 } })
    expect(response.statusCode).toBe(200)
    expect(service.unbindIdentity).toHaveBeenCalledWith(42, 'wechat_oauth', 'wx-app', '123456')
  })

  it('rejects unbind without SMS code or with an unsupported provider', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/member/social/wechat_oauth', headers: bearer(memberToken), payload: { tenant: 'wx-app' } })).statusCode).toBe(422)
    expect((await app.inject({ method: 'DELETE', url: '/member/social/phone', headers: bearer(memberToken), payload: { tenant: 'wx-app', code: '123456' } })).statusCode).toBe(400)
    expect(service.unbindIdentity).not.toHaveBeenCalled()
  })

  it('documents authentication on all protected routes but leaves login/callback public', () => {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth(undefined, 'auth').build())
    for (const [path, method] of [['/member/social/wechat-oauth/bind-url', 'post'], ['/member/social', 'get'], ['/member/social/unbind-sms', 'post'], ['/member/social/{provider}', 'delete']])
      expect(doc.paths[path][method].security).toEqual([{ auth: [] }])
    expect(doc.paths['/member/auth/wechat/oauth-url'].post.security ?? []).toEqual([])
    expect(doc.paths['/member/auth/wechat/callback'].get.security ?? []).toEqual([])
  })
})
