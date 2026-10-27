import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { EntityManager, QueryFailedError, Repository } from 'typeorm'

import { BusinessException } from '~/common/exceptions/biz.exception'
import { ErrorEnum } from '~/constants/error-code.constant'
import { MemberStatus } from '~/modules/member/member.constant'
import { MemberEntity } from '~/modules/member/member.entity'
import { MemberService } from '~/modules/member/member.service'

import { MemberPhoneLoginDto, MemberRegisterDto, SendMemberSmsCodeDto } from './dto/member-auth.dto'
import { MemberAuthService } from './member-auth.service'
import { SmsCodeService } from './services/sms-code.service'

describe('explicit member registration and phone login', () => {
  let rows: MemberEntity[]
  let service: MemberAuthService
  let sms: { consumeCode: jest.Mock }
  let memberService: MemberService
  let transaction: jest.Mock
  let globalRepository: { findOneBy: jest.Mock }
  let transactionManagers: { findOneBy: jest.Mock, findOne: jest.Mock }[]
  let saveError: Error | undefined
  const phone = '+8613800138000'
  const duplicate = (key: string) => new QueryFailedError('INSERT INTO member ...', [], {
    code: 'ER_DUP_ENTRY',
    errno: 1062,
    sqlMessage: `Duplicate entry 'phone' for key 'member.${key}'`,
  } as any)

  beforeEach(() => {
    rows = []
    transactionManagers = []
    saveError = undefined
    let nextId = 100
    const findRow = (where: Partial<MemberEntity>) => rows.find(row => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null
    globalRepository = {
      findOneBy: jest.fn(async (where: Partial<MemberEntity>) => findRow(where)),
    }
    memberService = new MemberService(globalRepository as unknown as Repository<MemberEntity>)
    // Model transactional persistence, rollback, and commit-time unique enforcement.
    transaction = jest.fn(async (callback: (manager: EntityManager) => Promise<MemberEntity>) => {
      const pending: MemberEntity[] = []
      const manager = {
        findOneBy: jest.fn(async (_target, where: Partial<MemberEntity>) => findRow(where)),
        findOne: jest.fn(async (_target, options: { where: Partial<MemberEntity> }) => findRow(options.where)),
        create: (_target, input) => Object.assign(new MemberEntity(), input),
        save: async (member: MemberEntity) => {
          if (saveError)
            throw saveError
          member.id = nextId++
          pending.push(member)
          return member
        },
      }
      transactionManagers.push(manager)
      const result = await callback(manager as unknown as EntityManager)
      for (const member of pending) {
        if (rows.some(row => row.phone === member.phone))
          throw duplicate('UQ_member_phone')
      }
      rows.push(...pending)
      return result
    })
    sms = { consumeCode: jest.fn().mockResolvedValue(undefined) }
    service = new MemberAuthService(sms as unknown as SmsCodeService, memberService, { transaction } as unknown as EntityManager)
  })

  it('registers a verified root member with its own invite code when no invite is supplied', async () => {
    const member = await service.register({ phone: '0086 13800138000', code: '123456' })
    expect(rows).toEqual([member])
    expect(member).toMatchObject({ phone, parentId: null, status: MemberStatus.Enabled, phoneVerifiedAt: expect.any(Date) })
    expect(member.inviteCode).toMatch(/^[a-f0-9]{16}$/)
    expect(sms.consumeCode).toHaveBeenCalledWith(phone, 'register', '123456')
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it('reads the normalized phone through the callback manager without acquiring a global repository connection', async () => {
    globalRepository.findOneBy.mockRejectedValue(new Error('No additional pool connection available'))

    const member = await service.register({ phone: '0086 13800138000', code: '123456' })

    expect(member.phone).toBe(phone)
    expect(transactionManagers[0].findOneBy).toHaveBeenCalledWith(MemberEntity, { phone })
    expect(globalRepository.findOneBy).not.toHaveBeenCalled()
    expect(rows).toEqual([member])
  })

  it('validates and share-locks the enabled inviter through the supplied transaction manager', async () => {
    rows.push(Object.assign(new MemberEntity(), { id: 7, phone: '+14155552671', status: MemberStatus.Enabled, inviteCode: 'abcdef0123456789' }))

    const member = await service.register({ phone, code: '123456', inviteCode: ' ABCDEF0123456789 ' })

    expect(member.parentId).toBe(7)
    expect(transactionManagers[0].findOne).toHaveBeenCalledWith(MemberEntity, {
      where: { inviteCode: 'abcdef0123456789', status: MemberStatus.Enabled },
      lock: { mode: 'pessimistic_read' },
    })
    expect(globalRepository.findOneBy).not.toHaveBeenCalled()
    expect(rows.find(row => row.phone === phone)?.parentId).toBe(7)
  })

  it.each([MemberStatus.Disable, MemberStatus.Cancelled])('rejects transaction-scoped inviter status %s even if a global lookup would return stale enabled data', async (status) => {
    const inviter = Object.assign(new MemberEntity(), { id: 7, phone: '+14155552671', status, inviteCode: 'abcdef0123456789' })
    rows.push(inviter)
    globalRepository.findOneBy.mockImplementation(async (where: Partial<MemberEntity>) => where.inviteCode ? { ...inviter, status: MemberStatus.Enabled } : null)

    await expect(service.register({ phone, code: '123456', inviteCode: 'abcdef0123456789' })).rejects.toMatchObject({ message: '邀请码无效或邀请人不可用' })

    expect(rows).toEqual([inviter])
    expect(transactionManagers[0].findOne).toHaveBeenCalledWith(MemberEntity, {
      where: { inviteCode: 'abcdef0123456789', status: MemberStatus.Enabled },
      lock: { mode: 'pessimistic_read' },
    })
    expect(globalRepository.findOneBy).not.toHaveBeenCalled()
  })

  it.each([undefined, '', '   '])('treats an empty optional invite %p as root registration', async (inviteCode) => {
    expect((await service.register({ phone, code: '123456', inviteCode })).parentId).toBeNull()
  })

  it('inserts the server-resolved enabled inviter ID with the member and ignores crafted ownership fields', async () => {
    rows.push(Object.assign(new MemberEntity(), { id: 7, phone: '+14155552671', status: MemberStatus.Enabled, inviteCode: 'abcdef0123456789' }))
    const member = await service.register({
      phone,
      code: '123456',
      inviteCode: ' ABCDEF0123456789 ',
      parentId: 999,
      parent_id: 999,
      parent: { id: 999 },
      id: 999,
      status: MemberStatus.Cancelled,
      phoneVerifiedAt: new Date(0),
    } as any)
    expect(member).toMatchObject({ parentId: 7, status: MemberStatus.Enabled, phone, phoneVerifiedAt: expect.any(Date) })
    expect(member.id).not.toBe(999)
    expect(member.phoneVerifiedAt.getTime()).toBeGreaterThan(0)
    expect(member.parent).toBeUndefined()
    expect(member.inviteCode).not.toBe('abcdef0123456789')
    expect(rows.find(row => row.id === member.id)?.parentId).toBe(7)
  })

  it.each([null, MemberStatus.Disable, MemberStatus.Cancelled])('rolls back registration for an invalid or unavailable inviter %p', async (status) => {
    if (status !== null)
      rows.push(Object.assign(new MemberEntity(), { id: 7, phone: '+14155552671', status, inviteCode: 'abcdef0123456789' }))
    const original = [...rows]
    await expect(service.register({ phone, code: '123456', inviteCode: 'abcdef0123456789' })).rejects.toMatchObject({ message: '邀请码无效或邀请人不可用' })
    expect(rows).toEqual(original)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(sms.consumeCode).toHaveBeenCalledWith(phone, 'register', '123456')
  })

  it.each([MemberStatus.Enabled, MemberStatus.Disable, MemberStatus.Cancelled])('does not re-register a phone owned by a member of status %s', async (status) => {
    rows.push(Object.assign(new MemberEntity(), { id: 7, phone, status }))
    await expect(service.register({ phone: '13800138000', code: '123456' })).rejects.toMatchObject({ message: '手机号已注册' })
    expect(rows).toHaveLength(1)
  })

  it('lets the database unique key choose one winner in a same-phone registration race', async () => {
    const results = await Promise.allSettled([
      service.register({ phone, code: '123456' }),
      service.register({ phone: '13800138000', code: '654321' }),
    ])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ message: '手机号已注册' })
    expect(rows).toHaveLength(1)
    expect(rows[0].phone).toBe(phone)
  })

  it('maps a phone unique-key failure at insert time to the member conflict error', async () => {
    saveError = duplicate('UQ_member_phone')
    await expect(service.register({ phone, code: '123456' })).rejects.toMatchObject({ message: '手机号已注册' })
    expect(rows).toEqual([])
  })

  it.each([new Error('database unavailable'), duplicate('unrelated_unique_key')])('propagates unrelated database errors without committing a member', async (error) => {
    saveError = error
    await expect(service.register({ phone, code: '123456' })).rejects.toBe(error)
    expect(rows).toEqual([])
  })

  it('does not enter the database transaction when the registration code is rejected', async () => {
    const error = new BusinessException(ErrorEnum.MEMBER_SMS_CODE_INVALID)
    sms.consumeCode.mockRejectedValue(error)
    await expect(service.register({ phone, code: '123456' })).rejects.toBe(error)
    expect(transaction).not.toHaveBeenCalled()
    expect(rows).toEqual([])
  })

  it('keeps an already consumed registration code consumed after later invite validation fails', async () => {
    let consumed = false
    sms.consumeCode.mockImplementation(async () => {
      if (consumed)
        throw new BusinessException(ErrorEnum.MEMBER_SMS_CODE_INVALID)
      consumed = true
    })
    await expect(service.register({ phone, code: '123456', inviteCode: 'abcdef0123456789' })).rejects.toMatchObject({ message: '邀请码无效或邀请人不可用' })
    await expect(service.register({ phone, code: '123456' })).rejects.toMatchObject({ message: '验证码无效或已过期' })
    expect(rows).toEqual([])
  })

  it('logs in an existing enabled member without inserting or changing any member', async () => {
    const member = Object.assign(new MemberEntity(), { id: 7, phone, status: MemberStatus.Enabled, parentId: 6 })
    rows.push(member)
    await expect(service.loginByPhone({ phone: '138 0013 8000', code: '123456' })).resolves.toBe(member)
    expect(sms.consumeCode).toHaveBeenCalledWith(phone, 'login', '123456')
    expect(rows).toEqual([member])
    expect(transaction).not.toHaveBeenCalled()
  })

  it.each([null, MemberStatus.Disable, MemberStatus.Cancelled])('rejects unknown or unavailable login status %p and never creates a member', async (status) => {
    if (status !== null)
      rows.push(Object.assign(new MemberEntity(), { id: 7, phone, status }))
    const original = [...rows]
    await expect(service.loginByPhone({ phone, code: '123456' })).rejects.toMatchObject({ message: '手机号或验证码不正确' })
    expect(rows).toEqual(original)
    expect(transaction).not.toHaveBeenCalled()
  })

  it('returns the same credential error for an invalid login-purpose code', async () => {
    sms.consumeCode.mockRejectedValue(new BusinessException(ErrorEnum.MEMBER_SMS_CODE_INVALID))
    await expect(service.loginByPhone({ phone, code: '123456' })).rejects.toMatchObject({ message: '手机号或验证码不正确' })
    expect(rows).toEqual([])
  })

  it('does not hide SMS infrastructure failures as invalid credentials', async () => {
    const error = new Error('Redis unavailable')
    sms.consumeCode.mockRejectedValue(error)
    await expect(service.loginByPhone({ phone, code: '123456' })).rejects.toBe(error)
  })
})

describe('member auth request validation', () => {
  it.each([MemberPhoneLoginDto, MemberRegisterDto])('requires a six-digit code and rejects crafted relationship fields in %p', async (Dto) => {
    const dto = plainToInstance(Dto as typeof MemberPhoneLoginDto, { phone: '13800138000', code: '12ab56', parentId: 7, parent_id: 7, status: 1 })
    const errors = await validate(dto as object, { whitelist: true, forbidNonWhitelisted: true })
    expect(errors.map(error => error.property)).toEqual(expect.arrayContaining(['code', 'parentId', 'parent_id', 'status']))
  })

  it('validates a normalized optional invite and allows no invite', async () => {
    const dto = plainToInstance(MemberRegisterDto, { phone: '13800138000', code: '123456', inviteCode: ' ABCDEF0123456789 ' }) as { inviteCode: string }
    expect(dto.inviteCode).toBe('abcdef0123456789')
    expect(await validate(dto as object)).toEqual([])
    expect(await validate(plainToInstance(MemberRegisterDto, { phone: '13800138000', code: '123456' }) as object)).toEqual([])
  })

  it('rejects an oversized invite or phone and requires a phone for sends', async () => {
    const dto = plainToInstance(MemberRegisterDto, { phone: '1'.repeat(65), code: '123456', inviteCode: 'a'.repeat(17) })
    expect((await validate(dto as object)).map(error => error.property)).toEqual(expect.arrayContaining(['phone', 'inviteCode']))
    expect(await validate(new SendMemberSmsCodeDto())).not.toEqual([])
  })
})
