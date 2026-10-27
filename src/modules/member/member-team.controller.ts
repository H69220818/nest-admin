import { Controller, Get, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'

import { ApiResult } from '~/common/decorators/api-result.decorator'
import { ApiSecurityAuth } from '~/common/decorators/swagger.decorator'
import { MemberAuth } from '~/modules/member-auth/decorators/member-auth.decorator'
import { MemberUser } from '~/modules/member-auth/decorators/member-user.decorator'

import { MemberTeamDepthDto, MemberTeamDescendantsDto, MemberTeamPagerDto, MemberTeamRow } from './dto/member-team.dto'
import { MemberTeamService } from './member-team.service'

@ApiTags('Member - 会员团队')
@ApiSecurityAuth()
@MemberAuth()
@Controller('member/team')
export class MemberTeamController {
  constructor(private readonly teams: MemberTeamService) {}

  @Get('direct')
  @ApiOperation({ summary: '分页查询当前会员直属下级' })
  @ApiResult({ type: [MemberTeamRow], isPage: true })
  direct(@MemberUser() member: IMemberAuthUser, @Query() dto: MemberTeamPagerDto) {
    return this.teams.listDirect(Number(member.sub), dto)
  }

  @Get('ancestors')
  @ApiOperation({ summary: '查询当前会员上级链，最多 100 层' })
  @ApiResult({ type: [MemberTeamRow] })
  ancestors(@MemberUser() member: IMemberAuthUser, @Query() dto: MemberTeamDepthDto) {
    return this.teams.listAncestors(Number(member.sub), dto.maxDepth)
  }

  @Get('descendants')
  @ApiOperation({ summary: '按层级分页查询当前会员团队，最多 100 层' })
  @ApiResult({ type: [MemberTeamRow], isPage: true })
  descendants(@MemberUser() member: IMemberAuthUser, @Query() dto: MemberTeamDescendantsDto) {
    return this.teams.listDescendants(Number(member.sub), dto.maxDepth, dto)
  }
}
