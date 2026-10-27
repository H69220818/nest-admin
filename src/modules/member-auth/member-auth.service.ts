import { Injectable } from '@nestjs/common'
import { EntityManager, QueryFailedError } from 'typeorm'

import { BusinessException } from '~/common/exceptions/biz.exception'
import { ErrorEnum } from '~/constants/error-code.constant'
import { MemberStatus } from '~/modules/member/member.constant'
import { MemberEntity } from '~/modules/member/member.entity'
import { MemberService, normalizeMemberPhone } from '~/modules/member/member.service'

import { MemberPhoneLoginDto, MemberRegisterDto } from './dto/member-auth.dto'
import { SmsCodeService } from './services/sms-code.service'

@Injectable()
export class MemberAuthService {
  constructor(
    private readonly smsCodeService: SmsCodeService,
    private readonly memberService: MemberService,
    private readonly entityManager: EntityManager,
  ) {}

  async register(dto: MemberRegisterDto): Promise<MemberEntity> {
    const phone = normalizeMemberPhone(dto.phone)
    // Redis consumption deliberately survives later database rollback to prevent replay.
    await this.smsCodeService.consumeCode(phone, 'register', dto.code)

    try {
      return await this.entityManager.transaction(async (manager) => {
        if (await manager.findOneBy(MemberEntity, { phone }))
          throw new BusinessException(ErrorEnum.MEMBER_PHONE_EXISTS)

        let parentId: number | null = null
        const inviteCode = dto.inviteCode?.trim().toLowerCase()
        if (inviteCode) {
          const inviter = await manager.findOne(MemberEntity, {
            where: { inviteCode, status: MemberStatus.Enabled },
            lock: { mode: 'pessimistic_read' },
          })
          if (!inviter)
            throw new BusinessException(ErrorEnum.MEMBER_INVALID_INVITE_CODE)
          parentId = inviter.id
        }

        return this.memberService.createRegisteredMember({
          phone,
          phoneVerifiedAt: new Date(),
          parentId,
        }, manager)
      })
    }
    catch (error) {
      if (error instanceof QueryFailedError) {
        const driverError = error.driverError as { code?: string, errno?: number, sqlMessage?: string, message?: string }
        const phoneConflict = (driverError.code === 'ER_DUP_ENTRY' || driverError.errno === 1062)
          && /for key ['`](?:member\.)?UQ_member_phone['`]/i.test(driverError.sqlMessage ?? driverError.message ?? '')
        if (phoneConflict)
          throw new BusinessException(ErrorEnum.MEMBER_PHONE_EXISTS)
      }
      throw error
    }
  }

  async loginByPhone(dto: MemberPhoneLoginDto): Promise<MemberEntity> {
    const phone = normalizeMemberPhone(dto.phone)
    try {
      await this.smsCodeService.consumeCode(phone, 'login', dto.code)
    }
    catch (error) {
      if (error instanceof BusinessException
        && error.getErrorCode() === Number(ErrorEnum.MEMBER_SMS_CODE_INVALID.split(':')[0])) {
        throw new BusinessException(ErrorEnum.MEMBER_INVALID_CREDENTIALS)
      }
      throw error
    }

    const member = await this.memberService.findByNormalizedPhone(phone)
    if (!member || member.status !== MemberStatus.Enabled)
      throw new BusinessException(ErrorEnum.MEMBER_INVALID_CREDENTIALS)

    return member
  }
}
