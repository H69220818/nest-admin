import { MODULE_METADATA } from '@nestjs/common/constants'

import { MemberAuthModule } from '~/modules/member-auth/member-auth.module'

import { AuthModule } from './auth.module'

describe('authModule', () => {
  it('imports the module that provides the member guard required by JwtAuthGuard', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AuthModule) as unknown[]

    expect(imports).toContain(MemberAuthModule)
  })
})
