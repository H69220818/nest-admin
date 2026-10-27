import { createHash, randomInt } from 'node:crypto'

import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import Redis from 'ioredis'

import { InjectRedis } from '~/common/decorators/inject-redis.decorator'
import { BusinessException } from '~/common/exceptions/biz.exception'
import { ErrorEnum } from '~/constants/error-code.constant'
import { MemberStatus } from '~/modules/member/member.constant'
import { MemberService, normalizeMemberPhone } from '~/modules/member/member.service'

import {
  SMS_CODE_TTL_SECONDS,
  SMS_DEVICE_SEND_LIMIT,
  SMS_IP_SEND_LIMIT,
  SMS_MAX_CODE_ATTEMPTS,
  SMS_PHONE_SEND_LIMIT,
  SMS_PURPOSES,
  SMS_RATE_WINDOW_SECONDS,
  SMS_RESEND_SECONDS,
  SMS_SENDER,
  SmsPurpose,
  SmsRequestMeta,
  SmsSender,
} from '../member-auth.constant'

// One operation reserves every quota and the code, so concurrent sends cannot overspend.
const ISSUE_CODE_SCRIPT = `
if redis.call('EXISTS', KEYS[3]) == 1
  or tonumber(redis.call('GET', KEYS[4]) or '0') >= tonumber(ARGV[5])
  or tonumber(redis.call('GET', KEYS[5]) or '0') >= tonumber(ARGV[6])
  or (ARGV[9] == '1' and tonumber(redis.call('GET', KEYS[6]) or '0') >= tonumber(ARGV[7])) then
  return 0
end
redis.call('SET', KEYS[3], '1', 'EX', ARGV[4])
local last = 5
if ARGV[9] == '1' then last = 6 end
for index = 4, last do
  if redis.call('INCR', KEYS[index]) == 1 then
    redis.call('EXPIRE', KEYS[index], ARGV[8])
  end
end
if ARGV[2] == '1' then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
  redis.call('DEL', KEYS[2])
end
return 1
`

const CONSUME_CODE_SCRIPT = `
local digest = redis.call('GET', KEYS[1])
if not digest then return 0 end
if digest == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[2])
  return 1
end
local attempts = redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], redis.call('PTTL', KEYS[1]))
if attempts >= tonumber(ARGV[2]) then redis.call('DEL', KEYS[1], KEYS[2]) end
return 0
`

const REMOVE_UNDELIVERED_CODE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`

@Injectable()
export class SmsCodeService {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly memberService: MemberService,
    @Inject(SMS_SENDER) private readonly sender: SmsSender,
  ) {}

  async sendCode(rawPhone: string, purpose: SmsPurpose, requestMeta: SmsRequestMeta): Promise<{ success: true }> {
    const phone = normalizeMemberPhone(rawPhone)
    this.checkPurpose(purpose)
    const ip = requestMeta?.ip?.trim()
    if (!ip || ip.length > 128)
      throw new BadRequestException('缺少有效的请求来源')

    const deviceId = requestMeta.deviceId?.trim()
    if (deviceId && deviceId.length > 256)
      throw new BadRequestException('设备标识无效')

    let eligible = true
    if (purpose !== 'register') {
      const member = await this.memberService.findByNormalizedPhone(phone)
      eligible = member?.status === MemberStatus.Enabled
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const digest = this.digest(phone, purpose, code)
    const codeKey = this.codeKey(phone, purpose)
    const accepted = await this.redis.eval(
      ISSUE_CODE_SCRIPT,
      6,
      codeKey,
      `${codeKey}:attempts`,
      `member:auth:sms:limit:phone:${phone}:resend`,
      `member:auth:sms:limit:phone:${phone}:day`,
      `member:auth:sms:limit:ip:${this.hash(ip)}:day`,
      `member:auth:sms:limit:device:${this.hash(deviceId ?? '')}:day`,
      digest,
      eligible ? '1' : '0',
      SMS_CODE_TTL_SECONDS,
      SMS_RESEND_SECONDS,
      SMS_PHONE_SEND_LIMIT,
      SMS_IP_SEND_LIMIT,
      SMS_DEVICE_SEND_LIMIT,
      SMS_RATE_WINDOW_SECONDS,
      deviceId ? '1' : '0',
    )
    if (accepted !== 1)
      throw new BusinessException(ErrorEnum.MEMBER_SMS_RATE_LIMITED)

    // The same response and quotas apply to unknown/disabled login phones.
    if (eligible) {
      try {
        await this.sender.sendCode(phone, purpose, code)
      }
      catch {
        await this.redis.eval(REMOVE_UNDELIVERED_CODE_SCRIPT, 1, codeKey, digest)
        // Public login responses must not reveal account existence through vendor failures.
        if (purpose !== 'login')
          throw new BusinessException(ErrorEnum.MEMBER_SMS_SEND_FAILED)
      }
    }

    return { success: true }
  }

  async consumeCode(rawPhone: string, purpose: SmsPurpose, code: string): Promise<void> {
    const phone = normalizeMemberPhone(rawPhone)
    this.checkPurpose(purpose)
    if (typeof code !== 'string' || !/^\d{6}$/.test(code))
      throw new BusinessException(ErrorEnum.MEMBER_SMS_CODE_INVALID)

    const codeKey = this.codeKey(phone, purpose)
    const consumed = await this.redis.eval(
      CONSUME_CODE_SCRIPT,
      2,
      codeKey,
      `${codeKey}:attempts`,
      this.digest(phone, purpose, code),
      SMS_MAX_CODE_ATTEMPTS,
    )
    if (consumed !== 1)
      throw new BusinessException(ErrorEnum.MEMBER_SMS_CODE_INVALID)
  }

  private checkPurpose(purpose: SmsPurpose): void {
    if (!SMS_PURPOSES.includes(purpose))
      throw new BadRequestException('短信验证码用途无效')
  }

  private codeKey(phone: string, purpose: SmsPurpose): string {
    return `member:auth:sms:${purpose}:${phone}:code`
  }

  private digest(phone: string, purpose: SmsPurpose, code: string): string {
    return this.hash(`${phone}:${purpose}:${code}`)
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex')
  }
}
