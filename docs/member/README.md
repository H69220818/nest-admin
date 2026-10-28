# 会员模块使用说明

本文说明本项目新增的会员、手机号认证、微信登录、邀请关系和后台会员管理功能。

会员体系与后台 `sys_user` 完全独立：会员令牌不能访问后台接口，后台令牌也不能访问会员接口。本文中的接口路径需加全局前缀，默认是 `/api`。

## 功能范围

- 手机号验证码注册、登录和退出。
- 独立的会员 access token、refresh token 与多设备会话。
- 注册时可选绑定邀请人，绑定后不能补绑、换绑或解绑。
- 直属下级、上级链和多级团队查询。
- 微信网站/公众号 OAuth 绑定与登录。
- 微信小程序绑定与登录。
- 后台会员列表、详情、禁用、启用和注销。
- 管理员禁用或注销会员时，原子撤销该会员全部会话。

多级分佣规则、佣金流水和结算不在当前模块中；未来可沿 `member.parent_id` 递归取得上级链后单独实现。

## 数据表

迁移 `AddMemberDomain1793080800000` 创建以下表：

| 表 | 用途 |
| --- | --- |
| `member` | 会员主体、手机号、邀请码和直属上级 `parent_id` |
| `member_identity` | 微信 OAuth、小程序等第三方身份绑定 |
| `member_access_token` | 会员持久会话与 access token 摘要 |
| `member_refresh_token` | refresh token 轮换历史、消费和撤销状态 |

邀请关系只在 `member.parent_id` 保存直属上级。多级关系通过 MySQL 8 `WITH RECURSIVE` 查询，不维护闭包表或路径字段。

## 初始化

### 1. 配置会员密钥

会员 access 和 refresh 密钥是启动必填项，必须：

- 至少 32 个字符；
- 彼此不同；
- 不得与后台 `JWT_SECRET`、`REFRESH_TOKEN_SECRET` 相同。

本地开发建议在项目根目录创建不会提交的 `.env.local`。PowerShell 示例：

```powershell
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$accessBytes = New-Object byte[] 48
$refreshBytes = New-Object byte[] 48
$rng.GetBytes($accessBytes)
$rng.GetBytes($refreshBytes)
$rng.Dispose()

$access = [Convert]::ToBase64String($accessBytes)
$refresh = [Convert]::ToBase64String($refreshBytes)

@"
MEMBER_JWT_SECRET=$access
MEMBER_JWT_EXPIRE=900
MEMBER_REFRESH_TOKEN_SECRET=$refresh
MEMBER_REFRESH_TOKEN_EXPIRE=2592000
"@ | Set-Content -LiteralPath .env.local -Encoding utf8
```

不要把真实密钥提交到 Git。

### 2. 执行数据库迁移

生产环境保持 `DB_SYNCHRONIZE=false`，构建后执行迁移：

```bash
pnpm build
pnpm migration:run
```

数据库要求 MySQL 8；团队递归查询不兼容 MySQL 5.7。

### 3. 接入短信供应商

项目默认短信发送器会失败关闭，不会把验证码返回给客户端或写入日志。部署方需要在 `MemberAuthModule` 的 `SMS_SENDER` 注入点提供实现：

```ts
interface SmsSender {
  sendCode: (phone: string, purpose: 'register' | 'login' | 'unbind', code: string) => Promise<void>
}
```

供应商发送失败时必须抛出异常，不能假装发送成功。

## 手机号注册与登录

### 注册流程

1. 调用 `POST /member/auth/sms/register` 发送注册验证码。
2. 调用 `POST /member/auth/register`，提交手机号、验证码和可选邀请码。
3. 服务端在注册事务中解析邀请码并写入 `parent_id`。
4. 注册成功后返回会员 access token 和 refresh token。

手机号登录不会自动注册。未注册手机号必须先走注册接口。

注册请求示例：

```json
{
  "phone": "+8613800138000",
  "code": "123456",
  "inviteCode": "ABCD1234"
}
```

`inviteCode` 可省略。邀请码无效或邀请人不可用时，注册整体失败，不会静默忽略邀请码。

### 登录与刷新

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| POST | `/member/auth/sms/login` | 公开 | 发送登录验证码 |
| POST | `/member/auth/login` | 公开 | 手机号验证码登录，不自动注册 |
| POST | `/member/auth/refresh` | 公开 | 轮换 access/refresh token |
| POST | `/member/auth/logout` | 会员 | 注销当前会话 |

refresh token 是 64 字符不透明令牌。每次刷新都会轮换令牌，旧 access 立即失效；重放旧 refresh 会撤销该设备的整个会话。会员允许多设备同时登录，各设备会话彼此独立。

### 验证码规则

- 用途分为 `register`、`login`、`unbind`，不同用途不能混用。
- 验证码为 6 位数字，有效期 300 秒，成功验证后立即删除。
- 连续错误最多 5 次，达到上限后验证码作废。
- 发送限制跨用途共享，采用固定时间窗口。
- 登录验证码接口对未知、禁用手机号返回相同的公开响应，避免枚举账户。

## 会员资料与邀请关系

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/member/profile` | 获取当前会员安全资料 |
| PUT | `/member/profile` | 更新昵称、邮箱和头像 |
| GET | `/member/invite` | 获取邀请码和相对注册链接 |
| GET | `/member/team/direct` | 分页查询直属下级 |
| GET | `/member/team/ancestors` | 查询上级链 |
| GET | `/member/team/descendants` | 按层级分页查询团队 |

邀请规则：

- 邀请码仅在注册时可选提交。
- 注册后不能补绑、换绑或清空 `parent_id`。
- 客户端不能直接提交 `parentId`。
- 禁用或注销会员不会改变邀请链。
- 会员不物理删除，避免截断历史关系。
- 当前会员不计入查询结果，直属关系为 `level=1`。
- 默认递归深度为 10，最大为 100。

会员资料接口不会允许修改 ID、手机号、邀请码、直属上级或状态。额外字段会被生产验证管道剥离。

## 微信 OAuth 登录

### 环境变量

```dotenv
WECHAT_OAUTH_ENABLED=true
WECHAT_OAUTH_MODE=website
WECHAT_OAUTH_APP_ID=
WECHAT_OAUTH_APP_SECRET=
WECHAT_OAUTH_CALLBACK_URL=https://api.example.com/api/member/auth/wechat/callback
WECHAT_OAUTH_SCOPE=snsapi_login
WECHAT_OAUTH_RETURN_ORIGINS=https://member.example.com
WECHAT_OAUTH_STATE_TTL_SECONDS=600
WECHAT_OAUTH_HTTP_TIMEOUT_MS=5000
```

- `WECHAT_OAUTH_MODE` 支持 `website` 或 `official_account`。
- 网站模式使用 `snsapi_login`。
- 公众号模式使用 `snsapi_base` 或 `snsapi_userinfo`。
- `WECHAT_OAUTH_RETURN_ORIGINS` 是精确来源白名单，不支持通配符。
- 回调地址由服务端固定配置，客户端不能覆盖。

### 绑定和登录

会员必须先使用手机号登录，再绑定微信：

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| POST | `/member/social/wechat-oauth/bind-url` | 会员 | 创建微信绑定授权会话 |
| POST | `/member/auth/wechat/oauth-url` | 公开 | 创建微信登录授权会话 |
| GET | `/member/auth/wechat/callback` | 公开 | 消费微信 `code` 和一次性 `state` |

回调返回 JSON，包括可信 `returnUrl` 以及绑定结果或会员令牌。系统不会把令牌放进 302 跳转 URL。

第三方身份按 `(provider, AppID, openid)` 唯一识别。未绑定的微信身份不能登录，也不会自动创建或合并会员。`unionid` 只用于发现冲突，冲突后需要人工处理。

## 微信小程序登录

### 环境变量

```dotenv
WECHAT_MINIAPP_ENABLED=true
WECHAT_MINIAPP_APP_ID=
WECHAT_MINIAPP_APP_SECRET=
WECHAT_MINIAPP_CODE_TTL_SECONDS=300
WECHAT_MINIAPP_HTTP_TIMEOUT_MS=5000
```

### 流程

1. 小程序调用 `wx.login()` 获取一次性 `code`。
2. 已登录会员调用 `POST /member/social/wechat-miniapp/bind` 完成绑定。
3. 后续调用 `POST /member/auth/wechat-miniapp` 使用新的 `code` 登录。

服务端通过 `code2Session` 获取 `openid`/`unionid`。客户端不能提交可信的 `openid`、`unionid` 或会员 ID；`session_key` 不会被保存、返回或写入日志。code 在 Redis 中按哈希短期防重放。

## 第三方身份管理

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/member/social` | 会员 | 查询安全的绑定列表 |
| POST | `/member/social/unbind-sms` | 会员 | 向当前手机号发送解绑验证码 |
| DELETE | `/member/social/:provider` | 会员 | 使用解绑验证码解除指定身份 |

解绑微信身份不会删除会员，也不会改变邀请关系；手机号登录始终保留。

## 后台会员管理

后台接口继续使用原有管理员 JWT 和 RBAC：

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/members` | `member:list` |
| GET | `/members/:id` | `member:read` |
| PUT | `/members/:id/status` | `member:update-status` |

后台只允许查看会员和修改状态，不能更改手机号、邀请码或上下级关系。

禁用或注销会员时，状态变更与全部会话撤销在同一事务中完成。登录签发、刷新和状态调整统一按照“会员行 → 会话 → refresh”顺序加锁，防止并发登录逃过撤销。重新启用会员不会恢复旧会话。

## 令牌与安全边界

- 会员 JWT 包含 `aud=member`、`tokenType=access`、`sub` 和 `sessionId`。
- 会员 access/refresh 使用独立密钥，不能复用后台密钥。
- 数据库仅保存 access 摘要和 refresh HMAC 摘要，不保存明文 refresh token。
- 会员令牌只写入 `request.member`，后台令牌继续使用 `request.user`。
- 微信 `code`、`state`、小程序 code、token 和 `session_key` 会在日志路径中脱敏。
- OAuth state、短信验证码和小程序 code 都是短期、一次性的。
- 生产环境应使用 HTTPS，并限制可信回跳来源和 CORS 来源。

## 测试

普通测试：

```bash
pnpm exec jest --runInBand
pnpm build
```

完整 MySQL 8/Redis 集成测试位于：

```text
src/modules/member/member-flow.e2e-spec.ts
```

测试默认跳过。显式执行需要设置：

```dotenv
MEMBER_INTEGRATION=1
MEMBER_TEST_MYSQL_URL=mysql://root:password@127.0.0.1:3306
MEMBER_TEST_REDIS_URL=redis://127.0.0.1:6379/0
```

集成测试会创建和删除随机测试数据库，并使用带随机前缀的 Redis 键。只应连接可丢弃的测试实例。

## 常见问题

### 启动时报 `MEMBER_JWT_SECRET is missing or empty`

会员模块已启用，但没有配置会员密钥。按“初始化”章节创建 `.env.local` 后重启进程。

### 启动时报密钥必须相互独立

以下四个密钥中发生了重复：

- `MEMBER_JWT_SECRET`
- `MEMBER_REFRESH_TOKEN_SECRET`
- `JWT_SECRET`
- `REFRESH_TOKEN_SECRET`

重新生成两个不同的会员密钥，停止旧进程后重启。

### 微信未配置时能否先使用手机号功能

可以。保持：

```dotenv
WECHAT_OAUTH_ENABLED=false
WECHAT_MINIAPP_ENABLED=false
```

会员 JWT 密钥仍然必须配置。

### 为什么未注册手机号不能直接登录

这是明确的业务约束。手机号登录不会隐式注册，确保邀请码只能在注册事务中绑定一次。

## 相关文件

- `src/modules/member/`：会员主体、资料、后台管理和团队查询。
- `src/modules/member-auth/`：短信认证、会员 JWT、refresh 和守卫。
- `src/modules/member-social/`：微信 OAuth、小程序和第三方绑定。
- `src/migrations/1793080800000-add-member-domain.ts`：会员领域迁移。
- `docs/superpowers/specs/2026-10-27-member-social-invite-design.md`：设计说明。
- `docs/superpowers/plans/2026-10-27-member-social-invite-implementation.md`：实施计划。
