import Redis from 'ioredis'

import { MemberStatus } from '~/modules/member/member.constant'
import { MemberService } from '~/modules/member/member.service'

import { SmsCodeService } from './sms-code.service'

/** Redis protocol double; the Lua scripts also receive a separate live-Redis check. */
class SmsRedisDouble {
  values = new Map<string, { value: string, expiresAt: number }>()

  read(key: string): string | undefined {
    const item = this.values.get(key)
    if (item && item.expiresAt > Date.now())
      return item.value
    this.values.delete(key)
  }

  write(key: string, value: string, seconds: number): void {
    this.values.set(key, { value, expiresAt: Date.now() + seconds * 1000 })
  }

  eval = jest.fn(async (_script: string, keyCount: number, ...args: (string | number)[]) => {
    const keys = args.slice(0, keyCount) as string[]
    const argv = args.slice(keyCount).map(String)
    if (keyCount === 6) {
      const [digest, issue, ttl, cooldown, phoneLimit, ipLimit, deviceLimit, window, hasDevice] = argv
      if (this.read(keys[2]) || Number(this.read(keys[3]) ?? 0) >= Number(phoneLimit)
        || Number(this.read(keys[4]) ?? 0) >= Number(ipLimit)
        || (hasDevice === '1' && Number(this.read(keys[5]) ?? 0) >= Number(deviceLimit))) {
        return 0
      }

      this.write(keys[2], '1', Number(cooldown))
      for (const key of keys.slice(3, hasDevice === '1' ? 6 : 5)) {
        const count = Number(this.read(key) ?? 0)
        if (!count)
          this.write(key, '1', Number(window))
        else
          this.values.get(key).value = String(count + 1)
      }
      if (issue === '1') {
        this.write(keys[0], digest, Number(ttl))
        this.values.delete(keys[1])
      }
      return 1
    }

    if (this.read(keys[0]) === argv[0]) {
      this.values.delete(keys[0])
      if (keys[1])
        this.values.delete(keys[1])
      return 1
    }
    if (keyCount === 2 && this.read(keys[0])) {
      const attempts = Number(this.read(keys[1]) ?? 0) + 1
      this.values.set(keys[1], { value: String(attempts), expiresAt: this.values.get(keys[0]).expiresAt })
      if (attempts >= Number(argv[1])) {
        this.values.delete(keys[0])
        this.values.delete(keys[1])
      }
    }
    return 0
  })
}

describe('purpose-bound member SMS codes', () => {
  let redis: SmsRedisDouble
  let members: { findByNormalizedPhone: jest.Mock }
  let sender: { sendCode: jest.Mock }
  let service: SmsCodeService
  const phone = '+8613800138000'
  const meta = { ip: '192.0.2.1', deviceId: 'device-one' }
  const sentCode = () => sender.sendCode.mock.calls.at(-1)[2] as string

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-27T00:00:00Z'))
    redis = new SmsRedisDouble()
    members = { findByNormalizedPhone: jest.fn().mockResolvedValue({ id: 7, phone, status: MemberStatus.Enabled }) }
    sender = { sendCode: jest.fn().mockResolvedValue(undefined) }
    service = new SmsCodeService(redis as unknown as Redis, members as unknown as MemberService, sender)
  })

  afterEach(() => jest.useRealTimers())

  it.each(['register', 'login', 'unbind'] as const)('sends a cryptographic six-digit %s code and consumes it only once', async (purpose) => {
    await expect(service.sendCode('0086 13800138000', purpose, meta)).resolves.toEqual({ success: true })
    const code = sentCode()
    expect(sender.sendCode).toHaveBeenCalledWith(phone, purpose, expect.stringMatching(/^\d{6}$/))
    await expect(service.consumeCode('138 0013 8000', purpose, code)).resolves.toBeUndefined()
    await expect(service.consumeCode(phone, purpose, code)).rejects.toMatchObject({ getErrorCode: expect.any(Function) })
  })

  it.each([
    ['register', 'login'],
    ['register', 'unbind'],
    ['login', 'register'],
    ['login', 'unbind'],
    ['unbind', 'register'],
    ['unbind', 'login'],
  ] as const)('does not accept a %s code for %s or destroy its original purpose', async (source, purpose) => {
    await service.sendCode(phone, source, meta)
    const code = sentCode()
    await expect(service.consumeCode(phone, purpose, code)).rejects.toMatchObject({ message: expect.any(String) })
    await expect(service.consumeCode(phone, source, code)).resolves.toBeUndefined()
  })

  it('stores only a hash and compares the supplied code rather than consuming any nonempty code', async () => {
    await service.sendCode(phone, 'register', meta)
    const code = sentCode()
    const entry = [...redis.values.entries()].find(([key]) => key.endsWith(':code'))
    expect(entry[0]).toContain(`register:${phone}`)
    expect(entry[1].value).toMatch(/^[a-f0-9]{64}$/)
    expect(entry[1].value).not.toBe(code)
    const wrong = code === '000000' ? '111111' : '000000'
    await expect(service.consumeCode(phone, 'register', wrong)).rejects.toMatchObject({ message: expect.any(String) })
    await expect(service.consumeCode(phone, 'register', code)).resolves.toBeUndefined()
  })

  it('rejects an expired code after five minutes', async () => {
    await service.sendCode(phone, 'register', meta)
    const code = sentCode()
    jest.advanceTimersByTime(300_001)
    await expect(service.consumeCode(phone, 'register', code)).rejects.toMatchObject({ message: expect.any(String) })
  })

  it('atomically allows only one of two concurrent consumers', async () => {
    await service.sendCode(phone, 'register', meta)
    const results = await Promise.allSettled([
      service.consumeCode(phone, 'register', sentCode()),
      service.consumeCode(phone, 'register', sentCode()),
    ])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(redis.eval.mock.calls.filter(([, keys]) => keys === 2)).toHaveLength(2)
  })

  it('invalidates a code after five wrong attempts to bound guessing', async () => {
    await service.sendCode(phone, 'register', meta)
    const code = sentCode()
    for (let attempt = 0; attempt < 5; attempt++)
      await expect(service.consumeCode(phone, 'register', code === '000000' ? '111111' : '000000')).rejects.toBeDefined()
    await expect(service.consumeCode(phone, 'register', code)).rejects.toBeDefined()
  })

  it('limits resends across phone formats and SMS purposes for one minute', async () => {
    await service.sendCode(phone, 'register', meta)
    await expect(service.sendCode('13800138000', 'login', { ip: '192.0.2.2' })).rejects.toMatchObject({ message: expect.any(String) })
    expect(sender.sendCode).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(60_001)
    await expect(service.sendCode(phone, 'login', meta)).resolves.toEqual({ success: true })
  })

  it('atomically admits only one simultaneous send for a phone', async () => {
    const results = await Promise.allSettled([
      service.sendCode(phone, 'register', meta),
      service.sendCode('13800138000', 'register', meta),
    ])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(sender.sendCode).toHaveBeenCalledTimes(1)
  })

  it('limits each phone to five sends per rolling day even when IP and purpose change', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await service.sendCode(phone, attempt % 2 ? 'login' : 'register', { ip: `192.0.2.${attempt}` })
      jest.advanceTimersByTime(60_001)
    }
    await expect(service.sendCode(phone, 'unbind', { ip: '192.0.2.99' })).rejects.toBeDefined()
    expect(sender.sendCode).toHaveBeenCalledTimes(5)
    jest.advanceTimersByTime(86_400_001)
    await expect(service.sendCode(phone, 'register', meta)).resolves.toEqual({ success: true })
  })

  it('limits one IP to twenty sends per rolling day across different phones', async () => {
    for (let index = 0; index < 20; index++)
      await service.sendCode(`+1415555${String(index).padStart(4, '0')}`, 'register', { ip: meta.ip })
    await expect(service.sendCode('+14155559999', 'register', { ip: meta.ip })).rejects.toBeDefined()
    expect(sender.sendCode).toHaveBeenCalledTimes(20)
  })

  it('limits one supplied device to ten sends across IPs and phones', async () => {
    for (let index = 0; index < 10; index++)
      await service.sendCode(`+1415555${String(index).padStart(4, '0')}`, 'register', { ip: `192.0.2.${index}`, deviceId: meta.deviceId })
    await expect(service.sendCode('+14155559999', 'register', { ip: '192.0.2.99', deviceId: meta.deviceId })).rejects.toBeDefined()
    expect(sender.sendCode).toHaveBeenCalledTimes(10)
  })

  it.each([null, { status: MemberStatus.Disable }, { status: MemberStatus.Cancelled }])('returns the same login-send response for unavailable member %p without sending or storing a code', async (member) => {
    const knownResponse = await service.sendCode(phone, 'login', meta)
    members.findByNormalizedPhone.mockResolvedValue(member)
    const response = await service.sendCode('+14155552671', 'login', { ip: '192.0.2.2' })
    expect(response).toEqual(knownResponse)
    expect(sender.sendCode).toHaveBeenCalledTimes(1)
    expect([...redis.values.keys()].filter(key => key.includes('+14155552671') && key.endsWith(':code'))).toEqual([])
    await expect(service.sendCode('+14155552671', 'login', { ip: '192.0.2.3' })).rejects.toBeDefined()
  })

  it('does not send unbind codes for an unknown phone', async () => {
    members.findByNormalizedPhone.mockResolvedValue(null)
    await expect(service.sendCode(phone, 'unbind', meta)).resolves.toEqual({ success: true })
    expect(sender.sendCode).not.toHaveBeenCalled()
  })

  it('keeps login-send responses identical during a sender failure and removes the undelivered code', async () => {
    sender.sendCode.mockRejectedValue(new Error('vendor secret'))
    const knownResponse = await service.sendCode(phone, 'login', meta)
    members.findByNormalizedPhone.mockResolvedValue(null)
    expect(await service.sendCode('+14155552671', 'login', { ip: '192.0.2.2' })).toEqual(knownResponse)
    expect([...redis.values.keys()].filter(key => key.endsWith(':code'))).toEqual([])
    expect(sender.sendCode).toHaveBeenCalledTimes(1)
  })

  it('removes an undelivered code and hides sender details while preserving send limits', async () => {
    sender.sendCode.mockRejectedValue(new Error('vendor secret'))
    await expect(service.sendCode(phone, 'register', meta)).rejects.toMatchObject({ message: '验证码发送失败' })
    expect([...redis.values.keys()].filter(key => key.endsWith(':code'))).toEqual([])
    await expect(service.sendCode(phone, 'register', meta)).rejects.toBeDefined()
    expect(sender.sendCode).toHaveBeenCalledTimes(1)
  })

  it.each(['', '12345', '1234567', 'abcdef'])('rejects malformed verification input %s', async (code) => {
    await expect(service.consumeCode(phone, 'register', code)).rejects.toBeDefined()
    expect(redis.eval).not.toHaveBeenCalled()
  })

  it('rejects an invalid phone, purpose, or missing source IP before issuing a code', async () => {
    await expect(service.sendCode('invalid', 'register', meta)).rejects.toBeDefined()
    await expect(service.sendCode(phone, 'reset' as any, meta)).rejects.toBeDefined()
    await expect(service.sendCode(phone, 'register', { ip: '' })).rejects.toBeDefined()
    expect(sender.sendCode).not.toHaveBeenCalled()
    expect(redis.eval).not.toHaveBeenCalled()
  })
})
