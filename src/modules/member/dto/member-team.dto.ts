import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Expose, Transform } from 'class-transformer'
import { IsInt, IsOptional, Max, Min } from 'class-validator'

import { PagerDto } from '~/common/dto/pager.dto'

export class MemberTeamPagerDto extends PagerDto {
  // Read the original query value: PagerDto's parseInt would accept "1.5" / "2x".
  @ApiPropertyOptional({ minimum: 1, maximum: 2147483647, default: 1 })
  @Expose()
  @Transform(({ obj }) => obj.page === undefined ? 1 : Number(obj.page), { toClassOnly: true })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  page: number = 1

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 10 })
  @Expose()
  @Transform(({ obj }) => obj.pageSize === undefined ? 10 : Number(obj.pageSize), { toClassOnly: true })
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 10
}

export class MemberTeamDepthDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 10 })
  @Expose()
  @Transform(({ value }) => value === undefined ? 10 : Number(value), { toClassOnly: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxDepth: number = 10
}

export class MemberTeamDescendantsDto extends MemberTeamPagerDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 10 })
  @Expose()
  @Transform(({ value }) => value === undefined ? 10 : Number(value), { toClassOnly: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxDepth: number = 10
}

/** Team responses deliberately omit contact, invite, auth and social identity data. */
export class MemberTeamRow {
  @ApiProperty()
  id: number

  @ApiProperty({ type: Number, nullable: true })
  parentId: number | null

  @ApiProperty({ type: String, nullable: true })
  nickname: string | null

  @ApiProperty({ type: String, nullable: true })
  avatar: string | null

  @ApiProperty({ minimum: 1, maximum: 100, description: '与当前会员的关系层级，直属关系为 1' })
  level: number
}
