import { Injectable } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

import { MEMBER_JWT_STRATEGY } from './member-jwt.strategy'

@Injectable()
export class MemberJwtAuthGuard extends AuthGuard(MEMBER_JWT_STRATEGY) {
  constructor() {
    super({ property: 'member' })
  }
}
