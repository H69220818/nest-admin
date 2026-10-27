import { forwardRef, Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'

import { MemberAuthModule } from '~/modules/member-auth/member-auth.module'

import { MemberProfileController } from './member-profile.controller'
import { MemberController } from './member.controller'
import { MemberEntity } from './member.entity'
import { MemberService } from './member.service'

@Module({
  imports: [TypeOrmModule.forFeature([MemberEntity]), forwardRef(() => MemberAuthModule)],
  controllers: [MemberProfileController, MemberController],
  providers: [MemberService],
  exports: [MemberService],
})
export class MemberModule {}
