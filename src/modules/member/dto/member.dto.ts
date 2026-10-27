import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsEmail, IsEnum, IsInt, IsOptional, IsString, MaxLength } from 'class-validator'

import { MemberStatus } from '../member.constant'

export class MemberProfileUpdateDto {
  @ApiPropertyOptional({ description: '会员昵称', maxLength: 64, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  nickname?: string | null

  @ApiPropertyOptional({ description: '会员邮箱', maxLength: 255, nullable: true })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string | null

  @ApiPropertyOptional({ description: '会员头像', maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatar?: string | null
}

export class MemberStatusUpdateDto {
  @ApiProperty({ description: '会员状态', enum: MemberStatus })
  @IsInt()
  @IsEnum(MemberStatus)
  status: MemberStatus
}
