import { randomBytes } from 'node:crypto'

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { EntityManager, QueryFailedError, Repository } from 'typeorm'

import { PagerDto } from '~/common/dto/pager.dto'
import { paginate } from '~/helper/paginate'
import { Pagination } from '~/helper/paginate/pagination'
import { revokeLockedMemberSessions } from '~/modules/member-auth/services/member-session-revocation'

import { MemberProfileUpdateDto } from './dto/member.dto'
import { MemberStatus } from './member.constant'
import { MemberEntity } from './member.entity'
import { CreateRegisteredMemberInput, MemberInfo } from './member.model'

const memberInfoFields = ['id', 'createdAt', 'updatedAt', 'parentId', 'inviteCode', 'phone', 'email', 'nickname', 'avatar', 'status'] as const

/** Canonical E.164 identity; unprefixed mainland mobile numbers default to +86. */
export function normalizeMemberPhone(phone: string): string {
  if (typeof phone !== 'string' || !/^[+\d\s()-]+$/.test(phone))
    throw new BadRequestException('手机号格式无效')

  let normalized = phone.replace(/[\s()-]/g, '')
  if (normalized.startsWith('00'))
    normalized = `+${normalized.slice(2)}`
  else if (/^1[3-9]\d{9}$/.test(normalized))
    normalized = `+86${normalized}`

  if (!/^\+[1-9]\d{6,14}$/.test(normalized))
    throw new BadRequestException('手机号格式无效')

  return normalized
}

@Injectable()
export class MemberService {
  constructor(
    @InjectRepository(MemberEntity)
    private readonly memberRepository: Repository<MemberEntity>,
  ) {}

  async info(id: number): Promise<MemberInfo> {
    const member = await this.memberRepository.findOne({ where: { id }, select: [...memberInfoFields] })
    if (!member)
      throw new NotFoundException('会员不存在')

    return this.toInfo(member)
  }

  async list({ page, pageSize }: PagerDto): Promise<Pagination<MemberInfo>> {
    const query = this.memberRepository.createQueryBuilder('member')
      .select(memberInfoFields.map(field => `member.${field}`))
      .orderBy('member.id', 'DESC')
    const result = await paginate(query, { page, pageSize })
    return new Pagination(result.items.map(member => this.toInfo(member)), result.meta)
  }

  private toInfo(member: MemberEntity): MemberInfo {
    const { id, createdAt, updatedAt, parentId, inviteCode, phone, email, nickname, avatar, status } = member
    return { id, createdAt, updatedAt, parentId, inviteCode, phone, email, nickname, avatar, status }
  }

  findEnabledById(id: number): Promise<MemberEntity | null> {
    return this.memberRepository.findOneBy({ id, status: MemberStatus.Enabled })
  }

  findByNormalizedPhone(phone: string): Promise<MemberEntity | null> {
    return this.memberRepository.findOneBy({ phone: normalizeMemberPhone(phone) })
  }

  async findInviterByCode(code: string): Promise<MemberEntity | null> {
    const inviteCode = code.trim().toLowerCase()
    if (!inviteCode)
      return null

    return this.memberRepository.findOneBy({ inviteCode, status: MemberStatus.Enabled })
  }

  /** Registration owns the transaction; relationships are written only in this insert. */
  async createRegisteredMember(input: CreateRegisteredMemberInput, manager: EntityManager): Promise<MemberEntity> {
    const phone = normalizeMemberPhone(input.phone)
    for (let attempt = 0; attempt < 5; attempt++) {
      const member = manager.create(MemberEntity, {
        phone,
        phoneVerifiedAt: input.phoneVerifiedAt,
        parentId: input.parentId ?? null,
        nickname: input.nickname ?? null,
        email: input.email ?? null,
        avatar: input.avatar ?? null,
        status: MemberStatus.Enabled,
        inviteCode: randomBytes(8).toString('hex'),
      })

      try {
        return await manager.save(member)
      }
      catch (error) {
        if (!(error instanceof QueryFailedError))
          throw error

        const driverError = error.driverError as { code?: string, errno?: number, sqlMessage?: string, message?: string }
        const isInviteCollision = (driverError.code === 'ER_DUP_ENTRY' || driverError.errno === 1062)
          && /for key ['`](?:member\.)?UQ_member_invite_code['`]/i.test(driverError.sqlMessage ?? driverError.message ?? '')
        if (!isInviteCollision)
          throw error
      }
    }

    throw new ConflictException('生成会员邀请码失败，请重试')
  }

  async updateProfile(memberId: number, dto: MemberProfileUpdateDto): Promise<void> {
    const profile: MemberProfileUpdateDto = {}
    if (dto.nickname !== undefined)
      profile.nickname = dto.nickname
    if (dto.email !== undefined)
      profile.email = dto.email
    if (dto.avatar !== undefined)
      profile.avatar = dto.avatar

    if (Object.keys(profile).length === 0)
      return

    const result = await this.memberRepository.update(memberId, profile)
    if (result.affected === 0)
      throw new NotFoundException('会员不存在')
  }

  async updateStatus(memberId: number, status: MemberStatus): Promise<void> {
    if (![MemberStatus.Disable, MemberStatus.Enabled, MemberStatus.Cancelled].includes(status))
      throw new BadRequestException('会员状态无效')

    await this.memberRepository.manager.transaction(async (manager) => {
      // Same member -> session -> refresh lock order as issuance and rotation.
      const member = await manager.findOne(MemberEntity, {
        where: { id: memberId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!member)
        throw new NotFoundException('会员不存在')

      await manager.update(MemberEntity, { id: memberId }, { status })
      if (status !== MemberStatus.Enabled)
        await revokeLockedMemberSessions(manager, memberId)
    })
  }
}
