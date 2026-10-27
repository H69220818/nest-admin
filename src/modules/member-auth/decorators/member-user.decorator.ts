import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import { FastifyRequest } from 'fastify'

export const MemberUser = createParamDecorator((_data: unknown, context: ExecutionContext): IMemberAuthUser => {
  return context.switchToHttp().getRequest<FastifyRequest>().member
})
