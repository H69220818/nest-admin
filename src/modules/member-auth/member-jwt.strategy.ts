import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { FastifyRequest } from 'fastify'
import { ExtractJwt, Strategy } from 'passport-jwt'

import { IMemberAuthConfig, MemberAuthConfig } from '~/config/member-auth.config'

import { MemberTokenService } from './services/member-token.service'

export const MEMBER_JWT_STRATEGY = 'member-jwt'

@Injectable()
export class MemberJwtStrategy extends PassportStrategy(Strategy, MEMBER_JWT_STRATEGY) {
  constructor(
    @Inject(MemberAuthConfig.KEY) config: IMemberAuthConfig,
    private readonly tokens: MemberTokenService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.accessSecret,
      algorithms: ['HS256'],
      audience: 'member',
      ignoreExpiration: false,
      passReqToCallback: true,
    })
  }

  async validate(request: FastifyRequest): Promise<IMemberAuthUser> {
    const token = ExtractJwt.fromAuthHeaderAsBearerToken()(request)
    if (!token)
      throw new UnauthorizedException()
    return this.tokens.verifyAccess(token)
  }
}
