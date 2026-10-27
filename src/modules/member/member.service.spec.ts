import { BadRequestException, ConflictException, Module, NotFoundException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { EntityManager, QueryFailedError, Repository } from 'typeorm'

import { MemberAuthModule } from '~/modules/member-auth/member-auth.module'
import { MemberTokenService } from '~/modules/member-auth/services/member-token.service'

import { MemberProfileUpdateDto, MemberStatusUpdateDto } from './dto/member.dto'
import { MemberStatus } from './member.constant'
import { MemberEntity } from './member.entity'
import { MemberModule } from './member.module'
import { MemberService, normalizeMemberPhone } from './member.service'

describe('member service boundary', () => {
  const verifiedAt = new Date('2026-10-27T01:00:00.000Z')
  let service: MemberService
  let repository: { findOneBy: jest.Mock, update: jest.Mock }
  let manager: { create: jest.Mock, save: jest.Mock }

  beforeEach(() => {
    repository = {
      findOneBy: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    }
    manager = {
      create: jest.fn((_target, input) => Object.assign(new MemberEntity(), input)),
      save: jest.fn(async member => Object.assign(member, { id: 42 })),
    }
    service = new MemberService(repository as unknown as Repository<MemberEntity>)
  })

  const duplicate = (key: string) => new QueryFailedError('INSERT INTO member ...', [], {
    code: 'ER_DUP_ENTRY',
    errno: 1062,
    sqlMessage: `Duplicate entry 'value' for key 'member.${key}'`,
  } as any)

  it.each([
    ['13800138000', '+8613800138000'],
    [' 138 0013 8000 ', '+8613800138000'],
    ['+86 (138) 0013-8000', '+8613800138000'],
    ['0086 13800138000', '+8613800138000'],
    ['+1 (415) 555-2671', '+14155552671'],
    ['0044 7700 900123', '+447700900123'],
  ])('normalizes %s to a single phone identity', (phone, expected) => {
    expect(normalizeMemberPhone(phone)).toBe(expected)
    expect(normalizeMemberPhone(expected)).toBe(expected)
  })

  it.each(['', 'abc13800138000', '1380013800', '+0123456789', '+1234567890123456', '12155552671'])('rejects malformed phone %s', (phone) => {
    expect(() => normalizeMemberPhone(phone)).toThrow(BadRequestException)
  })

  it('uses the normalized phone for lookup without hiding disabled members', async () => {
    const member = Object.assign(new MemberEntity(), { id: 7, phone: '+8613800138000', status: MemberStatus.Disable })
    repository.findOneBy.mockResolvedValue(member)

    expect(await service.findByNormalizedPhone('0086 13800138000')).toBe(member)
    expect(repository.findOneBy).toHaveBeenCalledWith({ phone: '+8613800138000' })
  })

  it('queries enabled members by numeric ID', async () => {
    await expect(service.findEnabledById(7)).resolves.toBeNull()
    expect(repository.findOneBy).toHaveBeenCalledWith({ id: 7, status: MemberStatus.Enabled })
  })

  it('normalizes invite-code casing and requires an enabled inviter', async () => {
    await expect(service.findInviterByCode(' ABCDEF0123456789 ')).resolves.toBeNull()
    expect(repository.findOneBy).toHaveBeenCalledWith({ inviteCode: 'abcdef0123456789', status: MemberStatus.Enabled })
  })

  it('does not query an empty inviter code', async () => {
    await expect(service.findInviterByCode('   ')).resolves.toBeNull()
    expect(repository.findOneBy).not.toHaveBeenCalled()
  })

  it('creates a root member in the supplied transaction with a normalized phone and random invite code', async () => {
    const member = await service.createRegisteredMember({ phone: '13800138000', phoneVerifiedAt: verifiedAt }, manager as unknown as EntityManager)

    expect(member).toMatchObject({
      id: 42,
      phone: '+8613800138000',
      phoneVerifiedAt: verifiedAt,
      parentId: null,
      status: MemberStatus.Enabled,
    })
    expect(member.inviteCode).toMatch(/^[a-f0-9]{16}$/)
    expect(manager.save).toHaveBeenCalledWith(member)
    expect(repository.update).not.toHaveBeenCalled()
  })

  it('inserts only the server-resolved direct parent and whitelisted registration fields', async () => {
    const member = await service.createRegisteredMember({
      phone: '+1 (415) 555-2671',
      phoneVerifiedAt: verifiedAt,
      parentId: 7,
      nickname: 'New member',
      email: 'member@example.com',
      avatar: 'https://example.com/avatar.png',
      id: 999,
      inviteCode: 'attacker-code',
      parent: { id: 999 },
      status: MemberStatus.Cancelled,
    } as any, manager as unknown as EntityManager)

    expect(member).toMatchObject({ id: 42, phone: '+14155552671', parentId: 7, nickname: 'New member', email: 'member@example.com', avatar: 'https://example.com/avatar.png', status: MemberStatus.Enabled })
    expect(member.inviteCode).not.toBe('attacker-code')
    expect(member.parent).toBeUndefined()
  })

  it('retries an invite-code unique-key collision with fresh cryptographic randomness', async () => {
    manager.save.mockRejectedValueOnce(duplicate('UQ_member_invite_code'))

    const member = await service.createRegisteredMember({ phone: '13800138000', phoneVerifiedAt: verifiedAt, parentId: 7 }, manager as unknown as EntityManager)

    expect(manager.save).toHaveBeenCalledTimes(2)
    const attempts = manager.save.mock.calls.map(([attempt]) => attempt)
    expect(attempts[0].inviteCode).toMatch(/^[a-f0-9]{16}$/)
    expect(member.inviteCode).toMatch(/^[a-f0-9]{16}$/)
    expect(member.inviteCode).not.toBe(attempts[0].inviteCode)
    expect(member.parentId).toBe(7)
  })

  it('bounds repeated invite-code collisions instead of looping indefinitely', async () => {
    manager.save.mockRejectedValue(duplicate('UQ_member_invite_code'))

    await expect(service.createRegisteredMember({ phone: '13800138000', phoneVerifiedAt: verifiedAt }, manager as unknown as EntityManager)).rejects.toBeInstanceOf(ConflictException)
    expect(manager.save).toHaveBeenCalledTimes(5)
  })

  it.each(['UQ_member_phone', 'some_other_unique_key'])('propagates %s conflicts without retrying', async (key) => {
    const error = duplicate(key)
    manager.save.mockRejectedValue(error)

    await expect(service.createRegisteredMember({ phone: '13800138000', phoneVerifiedAt: verifiedAt }, manager as unknown as EntityManager)).rejects.toBe(error)
    expect(manager.save).toHaveBeenCalledTimes(1)
  })

  it('propagates non-duplicate database failures without retrying', async () => {
    const error = new Error('Database unavailable')
    manager.save.mockRejectedValue(error)

    await expect(service.createRegisteredMember({ phone: '13800138000', phoneVerifiedAt: verifiedAt }, manager as unknown as EntityManager)).rejects.toBe(error)
    expect(manager.save).toHaveBeenCalledTimes(1)
  })

  it('updates only mutable profile fields despite crafted immutable and status fields', async () => {
    await service.updateProfile(42, {
      nickname: 'Updated',
      email: null,
      avatar: 'https://example.com/new.png',
      parentId: 999,
      parent: { id: 999 },
      parent_id: 999,
      inviteCode: 'stolen-code',
      phone: '+14155552671',
      phoneVerifiedAt: verifiedAt,
      status: MemberStatus.Cancelled,
      id: 999,
    } as any)

    expect(repository.update).toHaveBeenCalledWith(42, { nickname: 'Updated', email: null, avatar: 'https://example.com/new.png' })
  })

  it('ignores a profile payload containing only forbidden fields', async () => {
    await service.updateProfile(42, { parentId: 999, inviteCode: 'new', phone: '+14155552671' } as any)
    expect(repository.update).not.toHaveBeenCalled()
  })

  it('reports a missing member for a profile update', async () => {
    repository.update.mockResolvedValue({ affected: 0 })
    await expect(service.updateProfile(42, { nickname: 'Updated' })).rejects.toBeInstanceOf(NotFoundException)
  })

  it.each([MemberStatus.Disable, MemberStatus.Enabled, MemberStatus.Cancelled])('updates status %s without changing identity or relationships', async (status) => {
    await service.updateStatus(42, status)
    expect(repository.update).toHaveBeenCalledWith(42, { status })
  })

  it.each([-1, 3, 'Enabled', null, undefined, { status: 1, parentId: 999 }])('rejects invalid status %p at the service boundary', async (status) => {
    await expect(service.updateStatus(42, status as any)).rejects.toBeInstanceOf(BadRequestException)
    expect(repository.update).not.toHaveBeenCalled()
  })

  it('reports a missing member for a status update', async () => {
    repository.update.mockResolvedValue({ affected: 0 })
    await expect(service.updateStatus(42, MemberStatus.Disable)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('exports an injectable member service from the member module', async () => {
    @Module({ providers: [{ provide: MemberTokenService, useValue: {} }], exports: [MemberTokenService] })
    class TestMemberAuthModule {}

    const module = await Test.createTestingModule({ imports: [MemberModule] })
      .overrideModule(MemberAuthModule)
      .useModule(TestMemberAuthModule)
      .overrideProvider(getRepositoryToken(MemberEntity))
      .useValue(repository)
      .compile()
    expect(module.get(MemberService)).toBeInstanceOf(MemberService)
    await module.close()
  })
})

describe('member mutation DTOs', () => {
  it.each([MemberProfileUpdateDto, MemberStatusUpdateDto])('rejects immutable extra fields in %p during request validation', async (Dto) => {
    const dto = plainToInstance(Dto as typeof MemberProfileUpdateDto, { nickname: 'Member', status: MemberStatus.Enabled, parentId: 7, phone: '13800138000', inviteCode: 'new-code' })
    const errors = await validate(dto as object, { whitelist: true, forbidNonWhitelisted: true })
    expect(errors.map(error => error.property)).toEqual(expect.arrayContaining(['parentId', 'phone', 'inviteCode']))
  })

  it('rejects oversized profile values and invalid email', async () => {
    const dto = plainToInstance(MemberProfileUpdateDto, { nickname: 'n'.repeat(65), email: 'invalid', avatar: 'a'.repeat(501) })
    expect((await validate(dto as object)).map(error => error.property)).toEqual(expect.arrayContaining(['nickname', 'email', 'avatar']))
  })

  it('allows omitted or cleared optional profile fields', async () => {
    expect(await validate(plainToInstance(MemberProfileUpdateDto, { nickname: null, email: null, avatar: null }))).toEqual([])
    expect(await validate(new MemberProfileUpdateDto())).toEqual([])
  })

  it('requires a valid numeric member status', async () => {
    expect(await validate(plainToInstance(MemberStatusUpdateDto, { status: MemberStatus.Cancelled }))).toEqual([])
    expect(await validate(plainToInstance(MemberStatusUpdateDto, { status: 'Enabled' }))).not.toEqual([])
    expect(await validate(new MemberStatusUpdateDto())).not.toEqual([])
  })
})
