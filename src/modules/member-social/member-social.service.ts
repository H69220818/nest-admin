import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common'
import Redis from 'ioredis'
import { EntityManager, Not, QueryFailedError } from 'typeorm'

import { InjectRedis } from '~/common/decorators/inject-redis.decorator'
import { IWechatConfig, WechatConfig } from '~/config/wechat.config'
import { SmsRequestMeta } from '~/modules/member-auth/member-auth.constant'
import { MemberTokenPair, MemberTokenService } from '~/modules/member-auth/services/member-token.service'
import { SmsCodeService } from '~/modules/member-auth/services/sms-code.service'
import { MemberIdentityProvider, MemberStatus } from '~/modules/member/member.constant'
import { MemberEntity } from '~/modules/member/member.entity'

import { MemberIdentityEntity } from './member-identity.entity'
import { NormalizedSocialIdentity } from './providers/member-social-provider'
import { WechatMiniappProvider } from './providers/wechat-miniapp.provider'
import { WechatOAuthProvider } from './providers/wechat-oauth.provider'

export interface MemberBinding {
  id: number
  provider: MemberIdentityProvider
  tenant: string
  displayName: string | null
  avatar: string | null
  createdAt: Date
}

interface OAuthState {
  intent: 'login' | 'bind'
  tenant: string
  memberId?: number
  returnUrl: string
}

// Compatible with Redis versions before GETDEL; consumption is still one atomic operation.
const CONSUME_STATE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then redis.call('DEL', KEYS[1]) end
return value
`

@Injectable()
export class MemberSocialService {
  private readonly logger = new Logger(MemberSocialService.name)

  constructor(
    @Inject(WechatConfig.KEY) private readonly config: IWechatConfig,
    @InjectRedis() private readonly redis: Redis,
    private readonly entityManager: EntityManager,
    private readonly oauth: WechatOAuthProvider,
    private readonly tokens: MemberTokenService,
    private readonly sms: SmsCodeService,
    private readonly miniapp: WechatMiniappProvider,
  ) {}

  async bindMiniapp(memberId: number, code: string): Promise<MemberBinding> {
    return this.bindIdentity(memberId, await this.exchangeMiniappCode(code))
  }

  async loginMiniapp(code: string): Promise<MemberTokenPair> {
    return this.loginByIdentity(await this.exchangeMiniappCode(code))
  }

  async createOAuthState(memberId: number | undefined, intent: 'login' | 'bind', returnUrl: string): Promise<{ authorizationUrl: string, expiresIn: number }> {
    this.validateReturnUrl(returnUrl)
    if (intent !== 'login' && intent !== 'bind')
      throw new BadRequestException('微信授权用途无效')
    if (intent === 'bind')
      await this.entityManager.transaction(manager => this.requireMember(manager, memberId))
    const state = randomBytes(32).toString('hex')
    const authorizationUrl = this.oauth.authorizationUrl(state)
    const value: OAuthState = { intent, tenant: this.config.appId, returnUrl, ...(intent === 'bind' ? { memberId } : {}) }
    const stored = await this.redis.set(this.stateKey(state), JSON.stringify(value), 'EX', this.config.stateTtlSeconds, 'NX')
    if (stored !== 'OK')
      throw new ServiceUnavailableException('无法创建微信授权会话')
    return { authorizationUrl, expiresIn: this.config.stateTtlSeconds }
  }

  async consumeOAuthCallback(code: string, state: string): Promise<({ intent: 'login', returnUrl: string } & MemberTokenPair) | { intent: 'bind', returnUrl: string, binding: MemberBinding }> {
    if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state))
      throw new BadRequestException('微信授权会话无效或已过期')
    const raw = await this.redis.eval(CONSUME_STATE_SCRIPT, 1, this.stateKey(state))
    let saved: OAuthState
    try {
      if (typeof raw !== 'string')
        throw new Error('Missing state')
      saved = JSON.parse(raw)
      if (!saved || !['login', 'bind'].includes(saved.intent) || saved.tenant !== this.config.appId
        || (saved.intent === 'bind' && (!Number.isSafeInteger(saved.memberId) || saved.memberId <= 0))) {
        throw new Error('Invalid state')
      }
      this.validateReturnUrl(saved.returnUrl)
    }
    catch {
      throw new BadRequestException('微信授权会话无效或已过期')
    }
    // Consumption survives provider errors and database rollbacks; callbacks cannot be replayed.
    const identity = await this.oauth.exchangeCode(code)
    if (identity.provider !== MemberIdentityProvider.WechatOAuth || identity.tenant !== saved.tenant)
      throw new BadRequestException('微信授权身份无效')
    if (saved.intent === 'bind')
      return { intent: 'bind', returnUrl: saved.returnUrl, binding: await this.bindIdentity(saved.memberId, identity) }
    return { intent: 'login', returnUrl: saved.returnUrl, ...await this.loginByIdentity(identity) }
  }

  async bindIdentity(memberId: number, identity: NormalizedSocialIdentity): Promise<MemberBinding> {
    this.validateIdentity(identity)
    try {
      return await this.entityManager.transaction('SERIALIZABLE', async (manager) => {
        await this.requireMember(manager, memberId)
        const subject = await manager.findOne(MemberIdentityEntity, {
          where: { provider: identity.provider, providerTenant: identity.tenant, providerSubject: identity.subject },
          lock: { mode: 'pessimistic_write' },
        })
        if (subject)
          throw new ConflictException('该第三方身份已被绑定')
        const binding = await manager.findOne(MemberIdentityEntity, {
          where: { memberId, provider: identity.provider, providerTenant: identity.tenant },
          lock: { mode: 'pessimistic_write' },
        })
        if (binding)
          throw new ConflictException('当前会员已绑定该平台身份')
        if (identity.unionId) {
          // A locking SERIALIZABLE read also protects an absent union ID against phantoms.
          // unionId is advisory across tenants/providers and is never used to merge accounts.
          const collision = await manager.findOne(MemberIdentityEntity, {
            where: { unionId: identity.unionId, memberId: Not(memberId) },
            lock: { mode: 'pessimistic_write' },
          })
          if (collision) {
            this.logger.warn({
              event: 'member_social_union_id_collision',
              attemptedMemberId: memberId,
              conflictingMemberId: collision.memberId,
              provider: identity.provider,
              tenant: identity.tenant,
              correlationId: randomUUID(),
            })
            throw new ConflictException('该微信身份已关联其他会员，请联系管理员')
          }
        }
        const row = manager.create(MemberIdentityEntity, {
          memberId,
          provider: identity.provider,
          providerTenant: identity.tenant,
          providerSubject: identity.subject,
          unionId: identity.unionId ?? null,
          displayName: identity.profile?.displayName?.slice(0, 64) ?? null,
          avatar: identity.profile?.avatar?.slice(0, 500) ?? null,
        })
        return this.safeBinding(await manager.save(MemberIdentityEntity, row))
      })
    }
    catch (error) {
      if (error instanceof QueryFailedError) {
        const driver = error.driverError as { code?: string, errno?: number }
        // Unique constraints remain the final identity/binding race boundary. Serialization
        // conflicts are safe failures: the caller must start a fresh OAuth authorization.
        if (['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(driver.code)
          || [1062, 1213, 1205].includes(driver.errno)) {
          throw new ConflictException('第三方身份绑定冲突，请重新授权')
        }
      }
      throw error
    }
  }

  async loginByIdentity(identity: NormalizedSocialIdentity): Promise<MemberTokenPair> {
    this.validateIdentity(identity)
    const memberId = await this.entityManager.transaction(async (manager) => {
      const binding = await manager.findOne(MemberIdentityEntity, {
        where: { provider: identity.provider, providerTenant: identity.tenant, providerSubject: identity.subject },
        lock: { mode: 'pessimistic_read' },
      })
      if (!binding)
        throw new UnauthorizedException('该第三方身份尚未绑定，请先使用手机号登录并绑定')
      await this.requireMember(manager, binding.memberId)
      return binding.memberId
    })
    return this.tokens.issue(memberId)
  }

  async listBindings(memberId: number): Promise<MemberBinding[]> {
    return this.entityManager.transaction(async (manager) => {
      await this.requireMember(manager, memberId)
      const rows = await manager.find(MemberIdentityEntity, {
        where: { memberId },
        select: ['id', 'provider', 'providerTenant', 'displayName', 'avatar', 'createdAt'],
        order: { id: 'ASC' },
      })
      return rows.map(row => this.safeBinding(row))
    })
  }

  async sendUnbindCode(memberId: number, meta: SmsRequestMeta): Promise<{ success: true }> {
    const member = await this.entityManager.transaction(manager => this.requireMember(manager, memberId))
    return this.sms.sendCode(member.phone, 'unbind', meta)
  }

  async unbindIdentity(memberId: number, provider: MemberIdentityProvider, tenant: string, code: string): Promise<void> {
    this.validateIdentity({ provider, tenant, subject: 'validation' })
    await this.entityManager.transaction(async (manager) => {
      const member = await this.requireMember(manager, memberId)
      const binding = await manager.findOne(MemberIdentityEntity, {
        where: { memberId, provider, providerTenant: tenant },
        lock: { mode: 'pessimistic_write' },
      })
      if (!binding)
        throw new NotFoundException('未找到第三方身份绑定')
      // Redis verification is purpose-scoped and one-use even if the delete later rolls back.
      await this.sms.consumeCode(member.phone, 'unbind', code)
      await manager.delete(MemberIdentityEntity, { id: binding.id, memberId })
    })
  }

  private async requireMember(manager: EntityManager, memberId: number | undefined): Promise<MemberEntity> {
    if (!Number.isSafeInteger(memberId) || memberId <= 0)
      throw new UnauthorizedException()
    const member = await manager.findOne(MemberEntity, {
      where: { id: memberId, status: MemberStatus.Enabled },
      lock: { mode: 'pessimistic_read' },
    })
    if (!member || !member.phone || !member.phoneVerifiedAt)
      throw new UnauthorizedException()
    return member
  }

  private validateIdentity(identity: NormalizedSocialIdentity): void {
    if (!identity || !Object.values(MemberIdentityProvider).includes(identity.provider)
      || typeof identity.tenant !== 'string' || !/^[\w-]{1,128}$/.test(identity.tenant)
      || typeof identity.subject !== 'string' || !/^[\w-]{1,191}$/.test(identity.subject)
      || (identity.unionId !== undefined && (typeof identity.unionId !== 'string' || !/^[\w-]{1,191}$/.test(identity.unionId)))) {
      throw new BadRequestException('第三方身份无效')
    }
  }

  private validateReturnUrl(returnUrl: string): void {
    try {
      if (typeof returnUrl !== 'string' || returnUrl.length > 2048)
        throw new Error('Invalid return URL')
      const url = new URL(returnUrl)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !this.config.returnOrigins.includes(url.origin))
        throw new Error('Untrusted return URL')
    }
    catch {
      throw new BadRequestException('不受信任的授权回跳地址')
    }
  }

  private stateKey(state: string): string {
    return `member:social:oauth:state:${createHash('sha256').update(state).digest('hex')}`
  }

  private async exchangeMiniappCode(code: string): Promise<NormalizedSocialIdentity> {
    const config = this.config.miniapp
    if (!config.enabled)
      throw new ServiceUnavailableException('微信小程序登录尚未配置')
    if (typeof code !== 'string' || !/^[\w-]{1,512}$/.test(code))
      throw new BadRequestException('微信小程序授权码无效')
    const key = `member:social:miniapp:code:${config.appId}:${createHash('sha256').update(code).digest('hex')}`
    let reserved: string | null
    try {
      reserved = await this.redis.set(key, '1', 'EX', config.codeTtlSeconds, 'NX')
    }
    catch {
      throw new ServiceUnavailableException('微信小程序授权服务暂不可用')
    }
    if (reserved !== 'OK')
      throw new BadRequestException('微信小程序授权码无效或已使用')
    // Never release this reservation: WeChat may have consumed the code even on timeout.
    const identity = await this.miniapp.exchangeCode(code)
    if (identity.provider !== MemberIdentityProvider.WechatMiniapp || identity.tenant !== config.appId)
      throw new BadRequestException('微信小程序授权身份无效')
    return identity
  }

  private safeBinding(row: MemberIdentityEntity): MemberBinding {
    return { id: row.id, provider: row.provider, tenant: row.providerTenant, displayName: row.displayName, avatar: row.avatar, createdAt: row.createdAt }
  }
}
