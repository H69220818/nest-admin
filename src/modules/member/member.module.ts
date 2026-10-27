import { forwardRef, Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'

import { MemberAuthModule } from '~/modules/member-auth/member-auth.module'

import { MemberProfileController } from './member-profile.controller'
import { MemberTeamController } from './member-team.controller'
import { MemberTeamService } from './member-team.service'
import { MemberController } from './member.controller'
import { MemberEntity } from './member.entity'
import { MemberService } from './member.service'

@Module({
  imports: [TypeOrmModule.forFeature([MemberEntity]), forwardRef(() => MemberAuthModule)],
  controllers: [MemberProfileController, MemberTeamController, MemberController],
  providers: [MemberService, MemberTeamService],
  exports: [MemberService],
})
export class MemberModule {}
