# 会员、第三方登录与营销邀请设计

## 1. 背景与意图

现有 `sys_user` 服务于后台管理系统，关联角色、部门、菜单权限以及后台 JWT 会话。本次新增面向业务端的会员能力，包括会员注册与登录、已登录会员绑定第三方身份、注册时可选绑定邀请人，以及为未来多级分佣提供可递归查询的上下级关系。

会员体系必须与后台管理员体系隔离，避免会员令牌进入后台 RBAC，也避免会员字段持续污染 `sys_user`。

## 2. 已确认的产品规则

- 会员与后台 `sys_user` 是两套独立账户。
- 邀请码在注册时可选。
- 邀请关系只记录直属上级；多级关系使用递归查询获得。
- 邀请关系只能在注册事务中建立，注册后不允许补绑、换绑或解绑。
- 登录方式为手机号、微信授权和微信小程序；微信身份只能由已经通过手机号登录的会员主动绑定。
- 不通过微信返回的手机号、unionid 或其他资料自动创建、合并会员。
- 未注册手机号必须走独立注册接口，手机号登录不能隐式创建会员。
- 第三方身份绑定成功后，可以作为该会员后续登录凭证。
- 多级佣金的触发事件、级数、比例、结算和退款规则留到下一阶段。

## 3. 目标、非目标与反目标

### 目标

- 建立清晰独立的会员领域模型和认证边界。
- 支持独立的手机号验证码注册与手机号验证码登录。
- 支持多个第三方平台，以稳定的外部身份唯一标识绑定会员。
- 安全地完成 OAuth 发起、回调、绑定、登录和解绑。
- 通过一个直属上级关联支持递归查询上级链与下级团队。
- 为未来佣金模块提供稳定的会员和邀请关系输入。

### 非目标

- 本阶段不实现佣金规则、订单归因、佣金流水或结算。
- 本阶段不保存祖先闭包、物化路径或会员层级快照。
- 不允许第三方首次授权自动创建会员。
- 不按手机号或邮箱自动合并两个会员。
- 不复用 `sys_role`、`sys_menu` 或后台部门体系作为会员权限体系。

### 反目标

- 不能让会员 JWT 通过后台 `JwtAuthGuard`。
- 不能依靠可被修改的昵称、手机号或邮箱作为第三方身份唯一键。
- 不能通过普通更新会员资料接口修改 `parent_id`。
- 不能物理删除会员而截断既有邀请链。

## 4. 方案比较与选择

### 方案 A：会员仅保存直属上级，递归联查（已选择）

在 `member.parent_id` 保存直属上级，自关联到 `member.id`。查询多级上级或团队时使用 MySQL 8 递归 CTE。模型简单、写入成本低，符合当前明确需求；深层或大团队统计未来可增加缓存或汇总表，但不改变权威关系数据。

### 方案 B：直属关系表加闭包表

额外保存所有祖先和层级距离，查询性能高，但注册时需维护多行关系，增加一致性成本。当前明确要求只保存一条上级关联，因此不采用。

### 方案 C：物化路径

在会员上保存祖先路径，团队前缀查询方便，但主键生成、路径维护、修复和索引更复杂。当前不可换绑降低了维护风险，但仍没有必要引入派生关系数据，因此不采用。

## 5. 模块边界

建议新增以下业务模块：

```text
src/modules/member/
  member.module.ts
  member.entity.ts
  member.controller.ts          # 后台会员管理；使用现有后台 RBAC
  member.service.ts
  dto/

src/modules/member-auth/
  member-auth.module.ts
  member-auth.controller.ts     # 会员注册、登录、刷新、退出
  member-token.service.ts
  member-jwt.strategy.ts
  member-jwt-auth.guard.ts
  entities/

src/modules/member-social/
  member-social.module.ts
  member-social.controller.ts   # 绑定发起、回调、解绑、第三方登录
  member-social.service.ts
  providers/                    # 各平台适配器
  entities/
```

如果团队倾向减少模块数量，`member-auth` 和 `member-social` 可以作为 `member` 的子目录，但认证守卫、令牌表和服务仍需与后台认证保持独立。

## 6. 数据模型

### 6.1 `member`

| 字段 | 类型建议 | 约束/说明 |
| --- | --- | --- |
| `id` | bigint unsigned | 主键；会员规模可能大于后台用户，避免沿用 int 的容量假设 |
| `parent_id` | bigint unsigned, nullable | 直属上级，自关联 `member.id`；注册后不可修改 |
| `invite_code` | varchar(16) | 随机、不可猜测、全局唯一；注册邀请入口 |
| `phone` | varchar(32) | 规范化后的会员基础身份，全局唯一 |
| `phone_verified_at` | datetime | 注册验证码校验成功时间 |
| `email` | varchar(255), nullable | 规范化后按业务要求唯一 |
| `nickname` | varchar(64), nullable | 展示信息 |
| `avatar` | varchar(500), nullable | 展示信息 |
| `status` | tinyint | 正常、禁用、注销等状态 |
| `created_at` / `updated_at` | datetime | 沿用项目公共时间字段风格 |

索引与约束：

- `UNIQUE(invite_code)`。
- `UNIQUE(phone)`。
- `INDEX(parent_id)`，用于直属下级与递归团队查询。
- `FOREIGN KEY(parent_id) REFERENCES member(id) ON DELETE RESTRICT`，禁止删除仍处于邀请链中的会员。
- `parent_id <> id` 可在应用层校验，并在数据库支持条件下增加 CHECK 作为第二道保护。
- 会员采用状态禁用或匿名化注销，不物理删除。

`parent_id` 不应出现在通用 `MemberUpdateDto` 中。代码层仅允许注册服务在创建会员时赋值，后台也不提供修改入口。

### 6.2 `member_identity`

| 字段 | 类型建议 | 约束/说明 |
| --- | --- | --- |
| `id` | bigint unsigned | 主键 |
| `member_id` | bigint unsigned | 所属会员，删除策略为 RESTRICT 或随注销保留 |
| `provider` | varchar(32) | 首期为 `wechat_oauth`、`wechat_miniapp` |
| `provider_subject` | varchar(191) | 微信 `openid`，它是具体 AppID 下的稳定用户标识 |
| `provider_tenant` | varchar(128) | 微信 AppID，避免不同应用下 openid 冲突 |
| `union_id` | varchar(191), nullable | 满足微信开放平台条件时返回，仅用于辅助识别和人工处置 |
| `display_name` / `avatar` | nullable | 第三方展示快照，不作为身份匹配依据 |
| `access_token_enc` | text, nullable | 仅业务确需调用第三方 API 时保存，并使用应用密钥加密 |
| `refresh_token_enc` | text, nullable | 同上 |
| `token_expires_at` | datetime, nullable | 第三方令牌过期时间 |
| `created_at` / `updated_at` | datetime | 审计时间 |

核心唯一约束：

- `UNIQUE(provider, provider_tenant, provider_subject)`：一个第三方身份只能归属一个会员。
- `UNIQUE(member_id, provider, provider_tenant)`：一个会员在同一平台/应用默认只绑定一个身份。
- 如果某个平台明确允许同一会员绑定多个账号，再按平台能力单独放宽第二个约束，不应一开始取消全局保护。

### 6.3 会员令牌

不要复用当前关联 `sys_user` 的 `user_access_tokens`。新增 `member_access_token` 和 `member_refresh_token`，或实现等价的独立会话表。JWT 至少包含：

```json
{
  "sub": "member-id",
  "aud": "member",
  "tokenType": "access",
  "sessionId": "uuid",
  "pv": 1
}
```

会员策略必须校验签名、`aud=member`、会员存在且状态正常、令牌确由服务签发且会话未撤销。后台 JWT 使用不同 `aud`，推荐进一步使用独立密钥，杜绝两套令牌误用。

## 7. 注册与邀请绑定

### 7.1 注册请求

会员注册是独立接口，请求至少包含手机号、短信验证码和可选的 `inviteCode?: string`。邀请码必须先标准化（例如去除首尾空格并统一大小写），再进行查找。登录接口不得在手机号不存在时自动注册。

### 7.2 注册事务

一个数据库事务完成：

1. 原子消费用途为“注册”的短信验证码；验证码必须与规范化手机号匹配。
2. 校验手机号未注册，最终由数据库唯一键处理并发注册竞争。
3. 如果 `inviteCode` 非空，查询状态允许邀请的上级会员；无效邀请码使整个注册失败，不静默忽略。
4. 创建会员，直接写入 `parent_id` 或 `NULL`，并记录手机号验证时间。
5. 生成并写入该会员自己的唯一邀请码；碰撞时有限次数重试。
6. 提交事务后签发会员会话。

因为 `parent_id` 与新会员在同一次插入中产生，不存在“注册后抢占补绑”的窗口。邀请码解析结果只能来自服务端查询，客户端不能直接传 `parentId`。

### 7.3 不可换绑保障

- `parent_id` 仅在实体创建数据中出现。
- 资料更新 DTO、后台编辑 DTO和仓储通用更新方法均不得接收 `parent_id`。
- 不提供绑定、换绑、清空上级的接口。
- 数据修复必须通过受审计的离线脚本或迁移完成，不能开放成后台功能。
- 注册场景中新会员尚无下级，因此只需防止邀请码指向无效会员；正常业务路径天然不会形成自环或循环。

## 8. 多级关系查询

MySQL 8 使用 `WITH RECURSIVE`。

### 上级链

从当前会员的 `parent_id` 向上递归，返回 `level=1` 的直属上级、`level=2` 的二级上级，以此类推。查询必须设置最大深度，例如 100 层，以抵御异常历史数据；同时在 CTE 中携带访问路径或使用深度限制避免坏数据无限递归。

### 下级团队

以当前会员为根，通过 `member.parent_id = tree.id` 向下递归。接口必须分页或按层级限制，不应一次返回整棵大树。常用能力建议拆分为：

- 直属下级分页：普通索引查询，不使用递归。
- 指定最大层级的团队分页或统计。
- 查询某会员的上级链，供未来分佣计算使用。

未来数据规模导致实时递归统计变慢时，可新增 Redis 缓存、每日团队统计表或异步汇总表；这些都是派生数据，`member.parent_id` 始终是权威来源。

## 9. 第三方绑定与登录流程

### 9.1 微信授权绑定发起

`POST /member/social/wechat-oauth/bind-url` 必须携带有效会员令牌。服务端生成：

- 一次性的高熵 `state`。
- PKCE `code_verifier` / `code_challenge`（平台支持时必须使用）。
- 当前 `memberId`、provider、回跳地址和短过期时间。

状态保存在 Redis，建议 5–10 分钟过期且一次性消费。客户端不能在回调中自行指定 `memberId`。

### 9.2 微信授权绑定回调

1. 原子获取并删除 Redis 中的 `state`，拒绝缺失、过期或重复使用。
2. 使用授权码和 PKCE 向平台换取身份。
3. 调用微信 adapter 标准化为 `{ provider: 'wechat_oauth', tenant: appId, subject: openid, unionId, profile }`。
4. 在事务中插入 `member_identity`。
5. 唯一键冲突时返回“该第三方账号已被绑定”，不可把身份转移给当前会员。

如果 OAuth 回调无法携带原会员 Authorization Header，以 Redis 中一次性 `state` 对应的会员为绑定目标；`state` 必须由已登录会员发起的接口创建。

### 9.3 微信授权登录

微信授权登录通过服务端创建授权 state、微信回调和受信任前端地址跳转完成：

1. 完成授权码校验并取得稳定 `subject`。
2. 用 `(provider, tenant, subject)` 查询 `member_identity`。
3. 未绑定时返回明确错误和“请先使用已有会员账号登录并绑定”的提示，不创建会员。
4. 已绑定时校验会员状态并签发会员令牌。

### 9.4 微信小程序绑定与登录

小程序前端调用 `wx.login()` 取得一次性 `code`，提交后端；后端使用对应 AppID 和 AppSecret 调用 `code2Session`，取得 `openid`、`session_key` 以及条件满足时的 `unionid`。

- 绑定接口要求有效会员令牌，将身份保存为 `(wechat_miniapp, appId, openid)`。
- 登录接口不要求会员令牌，但只允许查询已有绑定；未绑定时返回“请先使用手机号登录并绑定”。
- `code` 只能使用一次且短期有效，后端不能接受客户端直接提交的 openid 或 unionid 作为身份凭证。
- `session_key` 不作为长期登录凭证；只有解密微信数据确有需要时才短期加密保存或放入 Redis。

`unionid` 可以辅助检测“可能属于同一微信用户”的多个身份，但不能绕过主动绑定流程自动合并会员。发现 unionid 已出现在其他会员下时，应拒绝绑定并记录安全审计事件，交由人工处理。

### 9.5 手机号注册与登录

- `POST /member/auth/register/sms-code`：发送注册验证码，应对手机号、IP、设备和每日次数限流。
- `POST /member/auth/register`：消费注册验证码，创建唯一会员，可选绑定邀请码。
- `POST /member/auth/login/sms-code`：仅为已注册且状态正常的手机号发送登录验证码；对外响应可保持一致，避免枚举手机号。
- `POST /member/auth/login`：原子消费登录验证码；手机号不存在时返回统一登录失败，不创建会员。
- 注册码与登录码必须标记不同用途，不能交叉使用；验证码只存哈希或使用受控 Redis 值，短期过期且一次性消费。

### 9.6 解绑

解绑只能由已登录会员发起，建议要求近期手机号验证码二次验证。手机号是始终保留的基础登录身份，因此解绑微信身份不会造成无登录凭证；解绑不会改变 `parent_id`。

## 10. 接口建议

会员公开接口：

- `POST /member/auth/register/sms-code`：发送注册验证码。
- `POST /member/auth/register`：手机号验证码注册，可选邀请码。
- `POST /member/auth/login/sms-code`：发送登录验证码。
- `POST /member/auth/login`：手机号验证码登录；不自动注册。
- `POST /member/auth/refresh`：刷新令牌。
- `POST /member/auth/logout`：撤销当前会话。
- `POST /member/auth/wechat/oauth-url`：创建微信登录授权会话。
- `GET /member/auth/wechat/callback`：微信登录回调。
- `POST /member/auth/wechat-miniapp`：已绑定小程序身份登录。

会员登录后接口：

- `GET /member/profile`、`PUT /member/profile`。
- `GET /member/invite`：返回自己的邀请码和邀请链接。
- `GET /member/team/direct`：直属下级分页。
- `GET /member/team/ancestors`：上级链，可限制层级。
- `GET /member/team/descendants`：多级团队查询，必须限制层级和分页。
- `POST /member/social/wechat-oauth/bind-url`：创建微信授权绑定会话。
- `POST /member/social/wechat-miniapp/bind`：使用小程序 `code` 绑定。
- `DELETE /member/social/:provider`：解绑微信身份。

后台管理接口可以放在 `/members`，沿用当前 `definePermission` / `@Perm` 风格，例如 `member:list`、`member:read`、`member:update-status`。后台只允许查看上级和调整会员状态，不允许修改邀请关系。

## 11. 错误码建议

在现有 `ErrorEnum` 中为会员领域划分连续区间，例如 `2001+`：

- 会员不存在或已禁用。
- 会员登录凭证错误。
- 邀请码无效或邀请人不可用。
- 第三方平台不支持。
- OAuth state 无效或已过期。
- 第三方身份尚未绑定。
- 第三方身份已被其他会员绑定。
- 当前会员已绑定该平台身份。
- 微信身份解绑需要近期手机号验证码二次确认。

不要把第三方平台的原始错误、token 或用户信息直接返回客户端或写入普通日志。

## 12. 安全与一致性

- 手机验证码按注册与登录用途隔离、严格限流、短期过期并一次性消费；日志不得记录明文验证码。
- OAuth 回调校验 `state`、issuer、client/tenant、redirect URI；OIDC 还需校验 nonce、audience 和签名。
- 第三方 token 仅在确实需要调用平台 API 时持久化，并加密、脱敏日志、支持密钥轮换。
- 注册、身份绑定和唯一性判断依赖数据库约束兜底，不使用“先查再写”作为唯一并发保护。
- 邀请码使用密码学安全随机值，不直接暴露自增会员 ID。
- 会员接口单独限流，OAuth state、注册和登录采用更严格策略。
- 禁用会员时撤销其全部会员会话，但不改动其上下级关系。
- 会员会话默认允许多设备并存，以 `sessionId` 为粒度撤销；刷新令牌每次使用后轮换，旧令牌重放时撤销对应会话族。该策略独立于后台的 `multiDeviceLogin` 配置。

## 13. 迁移与兼容

- 通过 TypeORM migration 新建会员、会员身份和会员令牌表；生产环境保持 `synchronize=false`。
- 不修改现有 `sys_user`、后台角色、部门和菜单数据。
- `AppModule` 引入会员模块；后台 `AuthModule` 的现有行为保持不变。
- 全局后台 `JwtAuthGuard` 当前默认覆盖所有路由，实施时必须调整为能够按路由元数据选择后台或会员认证，或让一个统一入口守卫明确分派两种策略。不能简单把会员路由标记为 `@Public()` 后在控制器内自行相信 JWT。
- 当前全局守卫还承担演示模式写操作限制。实施时将会员注册、登录、刷新和微信回调从后台演示模式限制中显式分离；会员登录后的资料、绑定和解绑接口仍可按部署环境另设会员侧只读策略，不能误用后台登录路径特判。

## 14. 测试与验收

最低验收场景：

- 无邀请码注册成功，`parent_id` 为 `NULL`。
- 有效邀请码注册成功，`parent_id` 为邀请人 ID。
- 无效、禁用会员的邀请码注册失败且不产生会员。
- 未注册手机号登录失败且不创建会员；必须通过独立注册接口创建。
- 注册验证码不能用于登录，登录验证码也不能用于注册；验证码不能重放。
- 资料更新、后台更新以及构造额外字段均不能更改 `parent_id`。
- 多层邀请链能正确查出指定层级的祖先与后代。
- 已登录会员能绑定未占用的微信授权身份、小程序身份并随后登录。
- 未登录状态不能创建绑定 state。
- 相同第三方身份并发绑定时只有一个会员成功。
- 未绑定第三方身份不能登录，也不会自动创建或合并会员。
- 后台 token 不能访问会员受保护接口，会员 token 不能访问后台接口。
- 重放 OAuth state、刷新令牌重放、伪造 audience、禁用会员均被拒绝。
- 微信身份解绑需要近期手机号验证码，解绑后手机号登录仍可正常使用。

## 15. 留给实现阶段的合理裁量

- “微信登录”具体采用开放平台网站扫码、公众号网页授权或两者，以及对应回调页面；两者均应复用微信 OAuth adapter 边界，但配置不同 AppID、scope 和回调地址。
- 会员表主键在项目规模明确后选择 `int unsigned` 或 `bigint unsigned`；对外 DTO 应避免 JavaScript 大整数精度问题。
- 第三方展示资料是否每次登录同步。
- 团队递归接口的默认和最大深度、分页实现以及缓存阈值。
- OAuth token 是否需要持久化；若只用于身份认证，应尽量不保存。

## 16. 下一阶段扩展点

佣金模块应独立保存规则版本、业务订单归因、各层佣金流水、结算状态和退款冲正，不把金额或比例写进 `member`。产生佣金时，从购买会员沿 `parent_id` 递归取得当时需要的上级链，并将参与结算的会员、层级与规则版本固化到佣金流水，避免未来规则变化影响历史账目。
