import { MemberIdentityProvider } from '~/modules/member/member.constant'

export interface NormalizedSocialIdentity {
  provider: MemberIdentityProvider
  tenant: string
  subject: string
  unionId?: string
  profile?: { displayName?: string, avatar?: string }
}

export interface MemberSocialProvider {
  exchangeCode: (code: string) => Promise<NormalizedSocialIdentity>
}
