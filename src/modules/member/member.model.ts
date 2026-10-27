import { ApiProperty } from '@nestjs/swagger'

import { MemberStatus } from './member.constant'

/** Internal registration input. Resolve parentId from an enabled inviter on the server. */
export interface CreateRegisteredMemberInput {
  phone: string
  phoneVerifiedAt: Date
  parentId?: number | null
  nickname?: string | null
  email?: string | null
  avatar?: string | null
}

/** Explicit response fields: never serialize a loaded member entity or its relations. */
export class MemberInfo {
  @ApiProperty()
  id: number

  @ApiProperty()
  createdAt: Date

  @ApiProperty()
  updatedAt: Date

  @ApiProperty({ type: Number, nullable: true })
  parentId: number | null

  @ApiProperty()
  inviteCode: string

  @ApiProperty()
  phone: string

  @ApiProperty({ type: String, nullable: true })
  email: string | null

  @ApiProperty({ type: String, nullable: true })
  nickname: string | null

  @ApiProperty({ type: String, nullable: true })
  avatar: string | null

  @ApiProperty({ enum: MemberStatus })
  status: MemberStatus
}

export class MemberInviteInfo {
  @ApiProperty()
  inviteCode: string

  @ApiProperty({ description: '相对注册链接，客户端可拼接业务站点域名' })
  inviteLink: string
}
