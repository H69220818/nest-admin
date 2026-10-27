import { BadRequestException, HttpStatus, Logger, UnprocessableEntityException, ValidationPipe } from '@nestjs/common'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'

import { AllExceptionsFilter } from '~/common/filters/any-exception.filter'
import { LoggingInterceptor } from '~/common/interceptors/logging.interceptor'

import { MemberSocialController } from './member-social.controller'
import { MemberSocialService } from './member-social.service'

describe('member OAuth callback logging', () => {
  let app: NestFastifyApplication
  let debug: jest.SpyInstance
  let warn: jest.SpyInstance
  const consumeOAuthCallback = jest.fn()
  const loginMiniapp = jest.fn()
  const rejectionListeners = process.listeners('unhandledRejection')
  const exceptionListeners = process.listeners('uncaughtException')
  const state = 'a'.repeat(64)
  const safeQuery = 'safe=keep%26code%3Dpublic%2Bvalue&empty=&tag=one&tag=two'

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MemberSocialController],
      providers: [{ provide: MemberSocialService, useValue: { consumeOAuthCallback, loginMiniapp } }],
    }).compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    app.useGlobalInterceptors(new LoggingInterceptor())
    app.useGlobalFilters(new AllExceptionsFilter())
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

  beforeEach(() => {
    consumeOAuthCallback.mockReset()
    loginMiniapp.mockReset()
    debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined)
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await app?.close()
    // The real filter installs process hooks; remove only this suite's additions.
    for (const listener of process.listeners('unhandledRejection')) {
      if (!rejectionListeners.includes(listener))
        process.removeListener('unhandledRejection', listener)
    }
    for (const listener of process.listeners('uncaughtException')) {
      if (!exceptionListeners.includes(listener))
        process.removeListener('uncaughtException', listener)
    }
  })

  it('redacts credentials in both loggers when callback validation rejects a still-valid code', async () => {
    const response = await app.inject({ url: `/member/auth/wechat/callback?code=unexchanged-secret&state=invalid-secret-state&CoDe=duplicate-secret&StAtE=duplicate-state&%63ode=encoded-key-secret&${safeQuery}` })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual({ code: 422, message: expect.any(String), data: null })
    expect(consumeOAuthCallback).not.toHaveBeenCalled()
    for (const logger of [debug, warn]) {
      expect(logger).toHaveBeenCalledTimes(1)
      const output = JSON.stringify(logger.mock.calls)
      for (const secret of ['unexchanged-secret', 'invalid-secret-state', 'duplicate-secret', 'duplicate-state', 'encoded-key-secret'])
        expect(output).not.toContain(secret)
      expect(output).toContain('[REDACTED]')
      expect(output).toContain(safeQuery)
    }
  })

  it('redacts callback service errors without changing the error response or service inputs', async () => {
    consumeOAuthCallback.mockRejectedValueOnce(new BadRequestException('OAuth state invalid or expired'))
    const response = await app.inject({ url: `/member/auth/wechat/callback?code=service-secret-code&state=${state}&${safeQuery}` })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ code: 400, message: 'OAuth state invalid or expired', data: null })
    expect(consumeOAuthCallback).toHaveBeenCalledWith('service-secret-code', state)
    for (const logger of [debug, warn]) {
      expect(logger).toHaveBeenCalledTimes(1)
      const output = JSON.stringify(logger.mock.calls)
      expect(output).not.toContain('service-secret-code')
      expect(output).not.toContain(state)
      expect(output).toContain('code=[REDACTED]&state=[REDACTED]')
      expect(output).toContain(safeQuery)
    }
  })

  it('redacts both request and response logs while passing original callback credentials to the service', async () => {
    const result = { intent: 'bind', returnUrl: 'https://member.example/profile', binding: { id: 1 } }
    consumeOAuthCallback.mockResolvedValueOnce(result)
    const response = await app.inject({ url: `/member/auth/wechat/callback?code=success-secret-code&state=${state}&${safeQuery}` })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(result)
    expect(consumeOAuthCallback).toHaveBeenCalledWith('success-secret-code', state)
    expect(debug).toHaveBeenCalledTimes(2)
    expect(warn).not.toHaveBeenCalled()
    for (const [output] of debug.mock.calls) {
      expect(output).not.toContain('success-secret-code')
      expect(output).not.toContain(state)
      expect(output).toContain('code=[REDACTED]&state=[REDACTED]')
      expect(output).toContain(safeQuery)
    }
  })

  it('never logs miniapp POST bodies and redacts code in the request URL', async () => {
    loginMiniapp.mockResolvedValueOnce({ accessToken: 'member-access', refreshToken: 'member-refresh' })
    const response = await app.inject({ method: 'POST', url: '/member/auth/wechat-miniapp?code=query-secret-code', payload: { code: 'body-secret-code', session_key: 'private-session-key' } })
    expect(response.statusCode).toBe(201)
    expect(loginMiniapp).toHaveBeenCalledWith('body-secret-code')
    expect(debug).toHaveBeenCalledTimes(2)
    expect(warn).not.toHaveBeenCalled()
    const output = JSON.stringify(debug.mock.calls)
    expect(output).toContain('code=[REDACTED]')
    expect(output).not.toMatch(/query-secret-code|body-secret-code|session_key|private-session-key|member-access|member-refresh/)
  })

  it.each(['validation', 'service'])('does not log miniapp code when %s rejects the request', async (failure) => {
    loginMiniapp.mockRejectedValueOnce(new BadRequestException('微信小程序授权码无效或已使用'))
    const code = failure === 'validation' ? 'invalid secret body code' : 'secret-body-code'
    const response = await app.inject({ method: 'POST', url: '/member/auth/wechat-miniapp?code=secret-query-code', payload: { code } })
    expect(response.statusCode).toBe(failure === 'validation' ? 422 : 400)
    expect(debug).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    const output = JSON.stringify([...debug.mock.calls, ...warn.mock.calls])
    expect(output).toContain('code=[REDACTED]')
    expect(output).not.toMatch(/secret-query-code|secret-body-code|invalid secret body code/)
  })
})
