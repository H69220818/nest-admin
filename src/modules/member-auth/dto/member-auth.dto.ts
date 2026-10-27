import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Transform } from 'class-transformer'
import { IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator'

export class SendMemberSmsCodeDto {
  @ApiProperty({ description: '手机号，支持国际区号', example: '+8613800138000' })
  @IsString()
  @MinLength(7)
  @MaxLength(64)
  @Matches(/^[+\d\s()-]+$/)
  phone: string
}

export class MemberPhoneLoginDto extends SendMemberSmsCodeDto {
  @ApiProperty({ description: '六位短信验证码' })
  @IsString()
  @Matches(/^\d{6}$/)
  code: string
}

export class MemberRegisterDto extends MemberPhoneLoginDto {
  @ApiPropertyOptional({ description: '邀请人的邀请码' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @ValidateIf((_object, value) => value !== undefined && value !== null && value !== '')
  @IsString()
  @Matches(/^[a-f0-9]{16}$/)
  inviteCode?: string
}
