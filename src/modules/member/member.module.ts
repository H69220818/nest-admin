import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'

import { MemberEntity } from './member.entity'
import { MemberService } from './member.service'

@Module({
  imports: [TypeOrmModule.forFeature([MemberEntity])],
  providers: [MemberService],
  exports: [MemberService],
})
export class MemberModule {}
