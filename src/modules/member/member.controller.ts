import { Body, Controller, Get, Put, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'

import { ApiResult } from '~/common/decorators/api-result.decorator'
import { IdParam } from '~/common/decorators/id-param.decorator'
import { ApiSecurityAuth } from '~/common/decorators/swagger.decorator'
import { PagerDto } from '~/common/dto/pager.dto'
import { definePermission, Perm } from '~/modules/auth/decorators/permission.decorator'

import { MemberStatusUpdateDto } from './dto/member.dto'
import { MemberInfo } from './member.model'
import { MemberService } from './member.service'

export const permissions = definePermission('member', {
  LIST: 'list',
  READ: 'read',
  UPDATE_STATUS: 'update-status',
} as const)

@ApiTags('Member - 会员管理')
@ApiSecurityAuth()
@Controller('members')
export class MemberController {
  constructor(
    private readonly members: MemberService,
  ) {}

  @Get()
  @ApiOperation({ summary: '获取会员列表' })
  @ApiResult({ type: [MemberInfo], isPage: true })
  @Perm(permissions.LIST)
  list(@Query() dto: PagerDto) {
    return this.members.list(dto)
  }

  @Get(':id')
  @ApiOperation({ summary: '获取会员资料' })
  @ApiResult({ type: MemberInfo })
  @Perm(permissions.READ)
  read(@IdParam() id: number): Promise<MemberInfo> {
    return this.members.info(id)
  }

  @Put(':id/status')
  @ApiOperation({ summary: '调整会员状态' })
  @Perm(permissions.UPDATE_STATUS)
  async updateStatus(@IdParam() id: number, @Body() dto: MemberStatusUpdateDto): Promise<void> {
    await this.members.updateStatus(id, dto.status)
  }
}
