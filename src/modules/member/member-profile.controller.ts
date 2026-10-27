import { Body, Controller, Get, Put } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'

import { ApiResult } from '~/common/decorators/api-result.decorator'
import { MemberAuth } from '~/modules/member-auth/decorators/member-auth.decorator'
import { MemberUser } from '~/modules/member-auth/decorators/member-user.decorator'

import { MemberProfileUpdateDto } from './dto/member.dto'
import { MemberInfo, MemberInviteInfo } from './member.model'
import { MemberService } from './member.service'

@ApiTags('Member - 会员资料')
@MemberAuth()
@Controller('member')
export class MemberProfileController {
  constructor(private readonly members: MemberService) {}

  @Get('profile')
  @ApiOperation({ summary: '获取当前会员资料' })
  @ApiResult({ type: MemberInfo })
  profile(@MemberUser() member: IMemberAuthUser): Promise<MemberInfo> {
    return this.members.info(Number(member.sub))
  }

  @Put('profile')
  @ApiOperation({ summary: '更新当前会员资料' })
  async updateProfile(@MemberUser() member: IMemberAuthUser, @Body() dto: MemberProfileUpdateDto): Promise<void> {
    await this.members.updateProfile(Number(member.sub), dto)
  }

  @Get('invite')
  @ApiOperation({ summary: '获取当前会员邀请码和注册链接' })
  @ApiResult({ type: MemberInviteInfo })
  async invite(@MemberUser() member: IMemberAuthUser): Promise<MemberInviteInfo> {
    const { inviteCode } = await this.members.info(Number(member.sub))
    return { inviteCode, inviteLink: `/member/auth/register?inviteCode=${encodeURIComponent(inviteCode)}` }
  }
}
