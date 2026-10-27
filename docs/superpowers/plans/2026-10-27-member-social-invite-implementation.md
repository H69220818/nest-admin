# Member Social Auth and Invitation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated member system with explicit SMS registration/login, immutable optional inviter binding, recursive team queries, and member-initiated WeChat OAuth and mini-program identity binding/login.

**Architecture:** Add separate `member`, `member-auth`, and `member-social` modules alongside the existing admin modules. `member.parent_id` is the only authoritative invitation relation; member sessions and JWT validation are isolated from `sys_user` and admin RBAC. Provider adapters translate WeChat responses into a common identity key while database constraints and transactions enforce ownership.

**Tech Stack:** NestJS 11, TypeScript 5.8, TypeORM 0.3, MySQL 8, Redis/ioredis, Passport JWT, Axios, class-validator, Jest.

**Spec:** `docs/superpowers/specs/2026-10-27-member-social-invite-design.md`

## Global Constraints

- Keep `sys_user`, admin roles, departments, menus, tokens, and existing admin authentication behavior intact.
- A member stores only its direct `parent_id`; do not add closure, path, or ancestor snapshot data.
- `parent_id` may only be set by the registration transaction and may never be updated by an API.
- Registration is explicit and accepts an optional invite code; login must never auto-register.
- WeChat OAuth and mini-program identities may only be bound by an already authenticated member.
- Never auto-create or auto-merge a member from WeChat phone, openid, or unionid data.
- Use `(provider, provider_tenant, provider_subject)` as the external identity key; `union_id` is advisory only.
- Member and admin tokens must be mutually unusable; production remains `DB_SYNCHRONIZE=false` and schema changes use migrations.
- Member sessions allow multiple devices; rotate refresh tokens and revoke a token family after replay.

## Review Focus

- Concurrent registration of the same phone: exactly one member is created and an invite is never partially applied (Task 3).
- Crafted update payload containing `parentId`: relation remains unchanged through member and admin update paths (Tasks 2 and 6).
- Cross-audience token use: member JWT fails on admin endpoints and admin JWT fails on member endpoints (Task 5).
- Concurrent binding of one WeChat identity to different members: one succeeds and the other gets the domain conflict (Tasks 8 and 9).
- Replayed SMS code, OAuth state, mini-program code, or refresh token: second use is rejected without creating identity/session state (Tasks 3, 5, 8, and 9).

---

## File Structure

Create the following focused units:

- `src/modules/member/member.entity.ts` — member profile, direct parent relation, invite code, status.
- `src/modules/member/member.service.ts` — member lookup, registration persistence, profile/status operations.
- `src/modules/member/member.controller.ts` — admin-side member list/read/status endpoints under existing RBAC.
- `src/modules/member/member-profile.controller.ts` — member-side profile and invite summary.
- `src/modules/member/member-team.service.ts` and `.controller.ts` — direct and recursive relationship reads.
- `src/modules/member/member.module.ts` — TypeORM registration and exports.
- `src/modules/member/dto/*.ts`, `member.constant.ts`, `member.model.ts` — validation and response contracts.
- `src/modules/member-auth/entities/*.entity.ts` — member access sessions and refresh-token families.
- `src/modules/member-auth/services/sms-code.service.ts` — purpose-bound, one-use SMS verification.
- `src/modules/member-auth/services/member-token.service.ts` — issue, rotate, validate, and revoke member sessions.
- `src/modules/member-auth/member-auth.service.ts` and `.controller.ts` — explicit register/login/refresh/logout orchestration.
- `src/modules/member-auth/member-jwt.strategy.ts`, `member-jwt-auth.guard.ts`, and decorators — member-only request authentication.
- `src/modules/member-social/member-identity.entity.ts` — provider identity ownership.
- `src/modules/member-social/providers/*.ts` — common provider contract, WeChat OAuth, and mini-program adapters.
- `src/modules/member-social/member-social.service.ts` and `.controller.ts` — binding and provider-login orchestration.
- `src/modules/member-social/member-social.module.ts` — provider and persistence wiring.
- `src/config/member-auth.config.ts`, `src/config/wechat.config.ts` — member JWT/SMS and WeChat configuration.
- `src/migrations/*-add-member-domain.ts` — all new tables, indexes, and foreign keys.
- `types/global.d.ts` — add a distinct `IMemberAuthUser` payload type.
- `src/app.module.ts`, `src/config/index.ts`, `.env.development.example`, `.env.production.example` — module/config registration and documented variables.

### Task 1: Member Schema and Migration

**Files:**
- Create: `src/modules/member/member.constant.ts`
- Create: `src/modules/member/member.entity.ts`
- Create: `src/modules/member/member.entity.spec.ts`
- Create: `src/modules/member-social/member-identity.entity.ts`
- Create: `src/modules/member-auth/entities/member-access-token.entity.ts`
- Create: `src/modules/member-auth/entities/member-refresh-token.entity.ts`
- Create: `src/migrations/<timestamp>-add-member-domain.ts`

**Interfaces:**
- Produces: `MemberEntity`, `MemberIdentityEntity`, `MemberAccessTokenEntity`, `MemberRefreshTokenEntity`, `MemberStatus`, `MemberIdentityProvider`.
- Invariants: unique normalized phone and invite code; indexed nullable `parent_id`; unique provider identity; unique member/provider/tenant binding; self FK uses `ON DELETE RESTRICT`.

- [ ] **Step 1: Write failing metadata tests** asserting table names, required unique indexes, `parent_id` FK/index, identity composite constraints, and token cascade relationships.
- [ ] **Step 2: Run `pnpm test -- member.entity.spec.ts --runInBand`** and verify failure because entities do not exist.
- [ ] **Step 3: Implement enums and entity classes** with explicit snake_case database column names and TypeORM relations; do not expose token fields through serialization.
- [ ] **Step 4: Add one migration** whose `up` creates all four tables and constraints in dependency order and whose `down` removes them in reverse order.
- [ ] **Step 5: Run the entity test and `pnpm build`**; expect both to pass.
- [ ] **Step 6: Commit** with `feat(member): add member domain schema`.

### Task 2: Member Service and Immutable Relationship Boundary

**Files:**
- Create: `src/modules/member/member.model.ts`
- Create: `src/modules/member/dto/member.dto.ts`
- Create: `src/modules/member/member.service.ts`
- Create: `src/modules/member/member.service.spec.ts`
- Create: `src/modules/member/member.module.ts`

**Interfaces:**
- Consumes: entities from Task 1.
- Produces: `findEnabledById(id: number): Promise<MemberEntity | null>`, `findByNormalizedPhone(phone: string)`, `findInviterByCode(code: string)`, `createRegisteredMember(input, manager)`, `updateProfile(memberId, dto)`, `updateStatus(memberId, status)`.
- `MemberProfileUpdateDto` and admin status DTO contain no `parentId`, `inviteCode`, or phone mutation field.

- [ ] **Step 1: Write failing service tests** for normalized phone lookup, enabled-member lookup, unique random invite code retry, and rejection/ignoring of crafted `parentId` in profile updates.
- [ ] **Step 2: Run `pnpm test -- member.service.spec.ts --runInBand`** and verify the missing service failure.
- [ ] **Step 3: Implement DTOs, service, and module**; use repository/manager injection and a cryptographically random invite-code generator with bounded collision retries.
- [ ] **Step 4: Run the task tests and `pnpm build`**; expect pass.
- [ ] **Step 5: Commit** with `feat(member): add member service boundary`.

### Task 3: Purpose-Bound SMS Registration and Login

**Files:**
- Create: `src/modules/member-auth/member-auth.constant.ts`
- Create: `src/modules/member-auth/dto/member-auth.dto.ts`
- Create: `src/modules/member-auth/services/sms-code.service.ts`
- Create: `src/modules/member-auth/services/sms-code.service.spec.ts`
- Create: `src/modules/member-auth/member-auth.service.ts`
- Create: `src/modules/member-auth/member-auth.service.spec.ts`
- Modify: `src/constants/error-code.constant.ts`

**Interfaces:**
- Consumes: `MemberService` from Task 2 and `EntityManager`.
- Produces: `SmsPurpose = 'register' | 'login' | 'unbind'`; `sendCode(phone, purpose, requestMeta)`; `consumeCode(phone, purpose, code): Promise<void>`; `register(dto): Promise<MemberEntity>`; `loginByPhone(dto): Promise<MemberEntity>`.
- Registration input: normalized phone, SMS code, optional invite code. Login input: normalized phone and login-purpose SMS code.

- [ ] **Step 1: Write failing SMS tests** asserting purpose isolation, expiry, hash comparison, atomic one-use consumption, resend/IP/phone limits, and identical send responses for registered and unregistered login phones.
- [ ] **Step 2: Run the SMS test** and verify failure because the service is missing.
- [ ] **Step 3: Implement `SmsCodeService`** using namespaced Redis keys, a compare-and-delete Lua operation, short TTL, and injected sender interface; use a fake sender in tests.
- [ ] **Step 4: Write failing auth-service tests** for no-invite registration, valid inviter registration, invalid/disabled inviter rollback, same-phone concurrency conflict, unknown-phone login rejection, and login never creating a member.
- [ ] **Step 5: Run the auth-service test** and verify the expected failures.
- [ ] **Step 6: Implement registration and phone login orchestration**; consume purpose-specific codes and create member plus `parent_id` within one database transaction.
- [ ] **Step 7: Add member-domain error codes** in the reserved `2001+` range without changing existing codes.
- [ ] **Step 8: Run both task tests and `pnpm build`**; expect pass.
- [ ] **Step 9: Commit** with `feat(member-auth): add explicit sms registration and login`.

### Task 4: Member Token Sessions and Refresh Rotation

**Files:**
- Create: `src/config/member-auth.config.ts`
- Create: `src/modules/member-auth/services/member-token.service.ts`
- Create: `src/modules/member-auth/services/member-token.service.spec.ts`
- Modify: `src/config/index.ts`
- Modify: `types/global.d.ts`
- Modify: `.env.development.example`
- Modify: `.env.production.example`

**Interfaces:**
- Consumes: token entities from Task 1 and `MemberService.findEnabledById`.
- Produces: `issue(memberId): Promise<MemberTokenPair>`, `rotate(refreshToken): Promise<MemberTokenPair>`, `verifyAccess(token): Promise<IMemberAuthUser>`, `revokeSession(sessionId)`, `revokeAll(memberId)`.
- JWT payload: `{ sub: string, aud: 'member', tokenType: 'access', sessionId: string, pv: number }`.

- [ ] **Step 1: Write failing token tests** for exact audience/type claims, independent secret, multiple simultaneous sessions, expired/disabled rejection, refresh rotation, old-refresh replay revoking the family, and logout revocation.
- [ ] **Step 2: Run `pnpm test -- member-token.service.spec.ts --runInBand`** and verify failure.
- [ ] **Step 3: Implement member auth configuration and payload type** with separate access/refresh secrets and expiry values.
- [ ] **Step 4: Implement `MemberTokenService`** using opaque hashed refresh-token values, transactionally rotated token-family state, and persisted session verification.
- [ ] **Step 5: Document required environment keys** without modifying the user's local `.env`.
- [ ] **Step 6: Run the token tests and `pnpm build`**; expect pass.
- [ ] **Step 7: Commit** with `feat(member-auth): add isolated member sessions`.

### Task 5: Authentication Guard Routing and Public Auth Endpoints

**Files:**
- Create: `src/modules/member-auth/decorators/member-auth.decorator.ts`
- Create: `src/modules/member-auth/decorators/member-user.decorator.ts`
- Create: `src/modules/member-auth/member-jwt.strategy.ts`
- Create: `src/modules/member-auth/member-jwt-auth.guard.ts`
- Create: `src/modules/member-auth/member-auth.controller.ts`
- Create: `src/modules/member-auth/member-auth.module.ts`
- Create: `src/modules/member-auth/member-auth.e2e-spec.ts`
- Modify: `src/modules/auth/guards/jwt-auth.guard.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: Tasks 2–4 services.
- Produces: route metadata distinguishing `public`, `admin`, and `member`; registration, phone login, refresh, logout endpoints; `request.member` typed as `IMemberAuthUser`.

- [ ] **Step 1: Write failing e2e tests** covering explicit registration, unknown-phone login, member token on member route, admin/member cross-audience rejection, disabled member, public auth routes in demo mode, and protected member mutation behavior.
- [ ] **Step 2: Run the focused e2e test** and verify routing/auth failures.
- [ ] **Step 3: Implement member strategy, guard, decorators, controller, and module**; ensure protected member routes never become trusted merely through admin `@Public()` metadata.
- [ ] **Step 4: Refactor global guard routing minimally** so admin routes retain existing checks while public member auth and member-guard routes follow explicit metadata.
- [ ] **Step 5: Wire `MemberAuthModule` into `AppModule`** and preserve the current admin login behavior.
- [ ] **Step 6: Run the e2e test, existing tests, and `pnpm build`**; expect pass.
- [ ] **Step 7: Commit** with `feat(member-auth): route isolated member authentication`.

### Task 6: Member Profile and Admin Management

**Files:**
- Create: `src/modules/member/member-profile.controller.ts`
- Create: `src/modules/member/member.controller.ts`
- Create: `src/modules/member/member.controller.spec.ts`
- Modify: `src/modules/member/member.module.ts`

**Interfaces:**
- Consumes: member route metadata from Task 5 and `MemberService` from Task 2.
- Produces: member profile read/update and invite-summary endpoints; admin list/read/status endpoints with `member:list`, `member:read`, `member:update-status` permissions.

- [ ] **Step 1: Write failing controller tests** for member ownership, admin RBAC metadata, status disable revoking all sessions, and crafted `parentId`, phone, or invite-code fields not changing immutable identity data.
- [ ] **Step 2: Run the focused controller test** and verify failure.
- [ ] **Step 3: Implement both controllers and required service pagination** following existing `ApiResult`, `PagerDto`, `definePermission`, and `@Perm` conventions.
- [ ] **Step 4: Revoke all member sessions after an admin disables a member** without changing its invitation links.
- [ ] **Step 5: Run tests and `pnpm build`**; expect pass.
- [ ] **Step 6: Commit** with `feat(member): add profile and admin management`.

### Task 7: Direct and Recursive Team Queries

**Files:**
- Create: `src/modules/member/member-team.service.ts`
- Create: `src/modules/member/member-team.service.spec.ts`
- Create: `src/modules/member/member-team.controller.ts`
- Create: `src/modules/member/dto/member-team.dto.ts`
- Modify: `src/modules/member/member.module.ts`

**Interfaces:**
- Consumes: `MemberEntity.parent` relation and member authentication.
- Produces: `listDirect(memberId, pager)`, `listAncestors(memberId, maxDepth)`, `listDescendants(memberId, maxDepth, pager)` returning rows with explicit `level`.

- [ ] **Step 1: Write failing query tests** for a four-level chain, no-parent root, direct-only pagination, maximum-depth truncation, deterministic order, and a deliberately corrupted cycle terminating safely.
- [ ] **Step 2: Run `pnpm test -- member-team.service.spec.ts --runInBand`** and verify failure.
- [ ] **Step 3: Implement direct lookup with indexed `parent_id` and MySQL 8 recursive CTE queries**; bind all values, cap depth at 100, and prevent repeated-node traversal.
- [ ] **Step 4: Implement member-owned team endpoints** with validated page and depth limits; never return the whole unbounded tree.
- [ ] **Step 5: Run tests and `pnpm build`**; expect pass.
- [ ] **Step 6: Commit** with `feat(member): add recursive invitation queries`.

### Task 8: WeChat OAuth Adapter, Binding, and Login

**Files:**
- Create: `src/config/wechat.config.ts`
- Create: `src/modules/member-social/providers/member-social-provider.ts`
- Create: `src/modules/member-social/providers/wechat-oauth.provider.ts`
- Create: `src/modules/member-social/providers/wechat-oauth.provider.spec.ts`
- Create: `src/modules/member-social/member-social.service.ts`
- Create: `src/modules/member-social/member-social.service.spec.ts`
- Create: `src/modules/member-social/member-social.controller.ts`
- Create: `src/modules/member-social/member-social.module.ts`
- Modify: `src/config/index.ts`
- Modify: `src/app.module.ts`
- Modify: `.env.development.example`
- Modify: `.env.production.example`

**Interfaces:**
- Consumes: member guard/session APIs and `MemberIdentityEntity`.
- Produces: `NormalizedSocialIdentity { provider, tenant, subject, unionId?, profile? }`; `createOAuthState(memberId?, intent, returnUrl)`; `consumeOAuthCallback(code, state)`; `bindIdentity(memberId, identity)`; `loginByIdentity(identity)`.

- [ ] **Step 1: Write failing adapter tests** for authorization URL construction, exact AppID/redirect/state, code exchange, normalized openid/unionid, upstream timeout, and redacted errors.
- [ ] **Step 2: Run the adapter test** and verify failure.
- [ ] **Step 3: Implement the provider contract and Axios-based WeChat adapter** supporting configured website/official-account OAuth mode without leaking provider tokens.
- [ ] **Step 4: Write failing social-service tests** for one-use state, untrusted return URL rejection, bind requiring member context, unknown identity login rejection, same identity concurrent conflict, same member/provider/tenant conflict, and unionid collision rejection without auto-merge.
- [ ] **Step 5: Run the social-service test** and verify failure.
- [ ] **Step 6: Implement Redis-backed state and transactional identity binding** relying on database unique constraints for final concurrency protection.
- [ ] **Step 7: Implement bind URL, callback, login, list-bindings, and SMS-confirmed unbind endpoints**; whitelist configured return origins.
- [ ] **Step 8: Add config registration and documented environment keys**, then run task tests and `pnpm build`.
- [ ] **Step 9: Commit** with `feat(member-social): add wechat oauth binding and login`.

### Task 9: WeChat Mini-Program Adapter, Binding, and Login

**Files:**
- Create: `src/modules/member-social/providers/wechat-miniapp.provider.ts`
- Create: `src/modules/member-social/providers/wechat-miniapp.provider.spec.ts`
- Modify: `src/modules/member-social/member-social.service.ts`
- Modify: `src/modules/member-social/member-social.controller.ts`
- Modify: `src/modules/member-social/member-social.module.ts`
- Modify: `src/config/wechat.config.ts`
- Modify: `.env.development.example`
- Modify: `.env.production.example`

**Interfaces:**
- Consumes: `NormalizedSocialIdentity`, binding/login service from Task 8.
- Produces: `exchangeCode(code): Promise<NormalizedSocialIdentity>` for provider `wechat_miniapp`; authenticated bind endpoint and public bound-identity login endpoint.

- [ ] **Step 1: Write failing provider tests** for `code2Session` parameters, openid/unionid normalization, missing openid, WeChat errcode, timeout, and no logging/persistence of `session_key`.
- [ ] **Step 2: Run the provider test** and verify failure.
- [ ] **Step 3: Implement mini-program adapter** using configured mini-program AppID/secret and server-side `code2Session`.
- [ ] **Step 4: Write failing integration tests** for authenticated bind, unauthenticated bind rejection, unknown identity login without member creation, one-time code replay rejection, concurrent cross-member bind, and unionid collision.
- [ ] **Step 5: Implement mini-program bind/login endpoints** by reusing Task 8 identity ownership logic; never accept client-supplied openid or unionid.
- [ ] **Step 6: Run task tests and `pnpm build`**; expect pass.
- [ ] **Step 7: Commit** with `feat(member-social): add mini-program binding and login`.

### Task 10: Full Verification and Operational Documentation

**Files:**
- Create: `src/modules/member/member-flow.e2e-spec.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-27-member-social-invite-design.md` only if implementation reveals an approved design correction.

**Interfaces:**
- Consumes: all previous task interfaces.
- Produces: executable end-to-end acceptance coverage and deployment instructions.

- [ ] **Step 1: Write the full-flow e2e test**: register A without invite, register B with A's code, register C with B's code, verify ancestor levels, phone-login B, bind both WeChat channels, log in through each, reject all cross-audience/replay attempts, disable B, and verify all B sessions fail while relationships remain.
- [ ] **Step 2: Run the e2e test** against an isolated MySQL 8 and Redis test environment; expect pass with no external WeChat calls because adapters are mocked at the HTTP boundary.
- [ ] **Step 3: Document migration order, environment variables, WeChat callback whitelist, SMS sender integration point, rate limits, token rotation behavior, and rollback procedure** in `README.md`.
- [ ] **Step 4: Run `pnpm lint`, `pnpm test -- --runInBand`, and `pnpm build`**; all must exit 0.
- [ ] **Step 5: Inspect `git diff --check` and generated migration SQL**; expect no whitespace errors, destructive alterations to existing admin tables, or local secret values.
- [ ] **Step 6: Commit** with `test(member): verify member auth and invitation flows`.

## Self-Review Result

- Spec coverage: schema, immutable direct relation, explicit SMS registration/login, session isolation, recursive queries, both WeChat channels, admin management, migration, security, and acceptance testing are assigned to Tasks 1–10.
- Type consistency: `MemberEntity`, `NormalizedSocialIdentity`, `IMemberAuthUser`, and token/service signatures are introduced before consumption.
- Review-focus coverage: each listed concurrency, immutability, audience, ownership, and replay risk has a named test in its owning task.
- Scope discipline: commission rules, order attribution, ledger, settlement, refund reversal, closure tables, and automatic account merging remain outside this plan.
