# nest-admin

[![OpenRepos](https://img.shields.io/endpoint?url=https://openrepos.org/status/nest-admin.openrepos.org.json&style=flat-square)](https://nest-admin.openrepos.org/) ![](https://img.shields.io/github/commit-activity/m/buqiyuan/nest-admin) ![](https://img.shields.io/github/license/buqiyuan/nest-admin) ![](https://img.shields.io/github/repo-size/buqiyuan/nest-admin) ![](https://img.shields.io/github/languages/top/buqiyuan/nest-admin)

**基于 NestJs + TypeScript + TypeORM + Redis + MySql + Vue3 + Ant Design Vue 编写的一款简单高效的前后端分离的权限管理系统。希望这个项目在全栈的路上能够帮助到你。**

- 前端项目地址：[传送门](https://github.com/buqiyuan/vue3-antdv-admin)

## 演示地址

当前公开演示：

- 前端：<https://vue3-antdv-admin.pages.dev>
- 接口：<https://nest-admin-api.pages.dev>
- Swagger：<https://nest-admin-api.pages.dev/api-docs/>

前端配合上面的接口使用。演示环境账号见下方表格。

## 项目启动前的准备工作

- sql 文件：[/deploy/sql/nest_admin.sql](https://github.com/buqiyuan/nest-admin/tree/main/deploy/sql/nest_admin.sql) 用于数据库初始化
- 项目相关配置，如：配置 mysql 和 redis 连接
  - 公共配置: [.env](https://github.com/buqiyuan/nest-admin/blob/main/.env)
  - 开发环境模板: [.env.development.example](https://github.com/buqiyuan/nest-admin/blob/main/.env.development.example)
  - 生产环境模板: [.env.production.example](https://github.com/buqiyuan/nest-admin/blob/main/.env.production.example)

`.env.development` 与 `.env.production` 已加入 `.gitignore`，不会再随仓库分发密钥。首次启动前复制模板并填写密钥：

```bash
cp .env.development.example .env.development
cp .env.production.example .env.production
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 48   # REFRESH_TOKEN_SECRET
openssl rand -base64 48   # MEMBER_JWT_SECRET
openssl rand -base64 48   # MEMBER_REFRESH_TOKEN_SECRET
```

`JWT_SECRET` 和 `REFRESH_TOKEN_SECRET` 必须各自设置为至少 32 位的随机字符串。缺失、为空、短于 32 位，或仍使用已知占位值时，进程会拒绝启动。已经部署过的环境在升级后必须轮换这两个密钥，并重新拉取或构建镜像；旧的登录令牌会因此失效。仓库历史里出现过的 SMTP 授权码也应在邮件服务商处作废。

接口权限使用数据库里的当前角色，不信任 JWT 中的 `roles`。未写入 `user_access_tokens` 的令牌会被拒绝。仍保存在该表中的已签发令牌，在过期、退出登录或密钥轮换之前继续有效。

## 环境要求

- `nodejs` `20`+
- `docker` `20.x`+ ，其中 `docker compose`版本需要 `2.17.0`+
- `mysql` `8.x`+
- 使用 [`pnpm`](https://pnpm.io/zh/) 包管理器安装项目依赖

演示环境账号密码：

|   账号    |  密码  |    权限    |
| :-------: | :----: | :--------: |
| admin | a123456 | 超级管理员 |

> 所有新建的用户初始密码都为 a123456

本地部署账号密码：

|   账号    |  密码  |    权限    |
| :-------: | :----: | :--------: |
| admin | a123456 | 超级管理员 |

## 快速体验

先按上一节复制 `.env.production` 并分别写入足够长的 `JWT_SECRET` / `REFRESH_TOKEN_SECRET` / `MEMBER_JWT_SECRET` / `MEMBER_REFRESH_TOKEN_SECRET`。未配置密钥时服务会启动失败。

启动成功后，通过 <http://localhost:7001/api-docs/> 访问。

只构建后端镜像时，在仓库根目录执行。`PROJECT_DIR` 默认为 `/nest-admin`，不需要额外的 build-arg。要改安装路径时再加上 `--build-arg PROJECT_DIR=/your-path`。`docker compose` 构建时仍从 `.env` 读取 `PROJECT_DIR`。

```bash
docker build -t web-api .
```

镜像启动时会等待 `DB_HOST`（默认 `mysql`）的 `${DB_PORT:-3306}`，再执行迁移并交给 `pm2-runtime`。生产镜像不包含 devDependency `cross-env`，因此迁移直接调用 `typeorm` CLI，而不是 `pnpm migration:run`。`JWT_SECRET` 和 `REFRESH_TOKEN_SECRET` 需要在运行时注入，不要写进镜像。

```bash
pnpm docker:up
# or
docker compose --env-file .env --env-file .env.production up -d --no-build
```

停止并删除所有容器

```bash
pnpm docker:down
# or
docker compose --env-file .env --env-file .env.production down
```

删除镜像

```bash
pnpm docker:rmi
# or
docker rmi buqiyuan/nest-admin-server:stable
```

查看实时日志输出

```bash
pnpm docker:logs
# or
docker compose --env-file .env --env-file .env.production logs -f

```

## 本地开发

- 获取项目代码

```bash
git clone https://github.com/buqiyuan/nest-admin
```

- 【可选】如果你是新手，还不太会搭建`mysql/redis`，你可以使用 `Docker` 启动指定服务供本地开发时使用, 例如（需先复制并填写 `.env.development`）：

```bash
# 启动MySql服务
docker compose --env-file .env --env-file .env.development run -d --service-ports mysql
# 启动Redis服务
docker compose --env-file .env --env-file .env.development run -d --service-ports redis
```

- 安装依赖

```bash
cd nest-admin

pnpm install

```

- 运行
  启动成功后，通过 <http://localhost:7001/api-docs/> 访问。

```bash
pnpm dev
```

- 打包

```bash
pnpm build
```

## 数据库迁移

1. 更新数据库(或初始化数据)

```bash
pnpm migration:run
```

2. 生成迁移

```bash
pnpm migration:generate
```

3. 回滚到最后一次更新

```bash
pnpm migration:revert
```

更多细节，请移步至[官方文档](https://typeorm.io/migrations)

> [!TIP]
> 如果你的`实体类`或`数据库配置`有更新，请执行`npm run build`后再进行数据库迁移相关操作。

## 会员认证、微信绑定与邀请关系

会员接口独立于后台用户体系。手机号验证码显式注册 `POST /member/auth/register`，邀请人只在首次注册时确定；无邀请码则为根会员。登录不会自动注册、换邀请人或合并账户。本文接口路径均需加上 `GLOBAL_PREFIX`（默认 `/api`）；会员前端需自行实现页面，`/member/invite` 返回的相对注册链接也需由前端路由接管。成功结果在正式应用中位于统一响应的 `data` 字段。

### 部署与迁移顺序

先备份数据库，确认 MySQL **8.x**、Redis 可用并安装 Node **20+** / pnpm **9+**。设置 `DB_SYNCHRONIZE=false`，通过迁移管理结构；不要用自动同步替代迁移。新库按时间戳依次执行：

1. `InitData1707996695540`：既有后台初始化。
2. `UpdateTable2001717007831711`：既有后台结构更新。
3. `AddMemberDomain1793080800000`：创建 `member`、`member_identity`、`member_access_token`、`member_refresh_token` 四张表及索引、外键，不修改既有后台表。

已有部署保留迁移历史表，只执行尚未应用的迁移。先构建，再对目标环境运行迁移，最后启动新版本；多副本部署时指定一个迁移执行者。生产命令示例：

```bash
pnpm build
NODE_ENV=production node ./node_modules/typeorm/cli.js -d ./dist/config/database.config.js migration:show
NODE_ENV=production node ./node_modules/typeorm/cli.js -d ./dist/config/database.config.js migration:run
```

如果新库尚未执行旧初始化迁移，旧 SQL 包含多语句，需要加上 `npm_lifecycle_event=typeorm`，例如 `NODE_ENV=production npm_lifecycle_event=typeorm node ./node_modules/typeorm/cli.js -d ./dist/config/database.config.js migration:run`。开发环境可使用 `pnpm migration:run`，该脚本固定选择 development，不能当作生产环境命令。

### 会员环境变量

在未跟踪的环境文件或部署平台中补齐以下配置；开发模板可能未包含所有微信选项。不要覆盖已有 `.env`，也不要把 AppSecret 或令牌放入前端、镜像、URL 回跳参数或日志。正式应用优先读取 `.env.local`，然后 `.env.${NODE_ENV}`，再读取 `.env`；迁移 CLI 读取对应 `.env.${NODE_ENV}`，生产迁移需要的连接参数也可直接由运行环境注入。

| 变量 | 含义 / 默认值 |
| --- | --- |
| `MEMBER_JWT_SECRET` | 必填，至少 32 字符的独立随机会员 access 密钥 |
| `MEMBER_REFRESH_TOKEN_SECRET` | 必填，至少 32 字符的独立随机 refresh 摘要密钥 |
| `MEMBER_JWT_EXPIRE` | access 有效秒数，默认 `900`，正整数 |
| `MEMBER_REFRESH_TOKEN_EXPIRE` | refresh 有效秒数，默认 `2592000`，正整数 |
| `WECHAT_OAUTH_ENABLED` | 默认 `false`；启用后必须补全 OAuth 配置 |
| `WECHAT_OAUTH_MODE` | `website`（默认）或 `official_account` |
| `WECHAT_OAUTH_APP_ID` / `WECHAT_OAUTH_APP_SECRET` | 对应微信应用的 AppID / AppSecret |
| `WECHAT_OAUTH_CALLBACK_URL` | 服务端回调完整 URL，例如 `https://api.example.com/api/member/auth/wechat/callback` |
| `WECHAT_OAUTH_SCOPE` | 网站模式必须为 `snsapi_login`；公众号模式为 `snsapi_base` 或 `snsapi_userinfo`，启用时必须显式填写 |
| `WECHAT_OAUTH_RETURN_ORIGINS` | 前端可信来源，英文逗号分隔，例如 `https://member.example.com,https://member-staging.example.com` |
| `WECHAT_OAUTH_STATE_TTL_SECONDS` | 一次性 state 有效秒数，默认 `600`，范围 `300..600` |
| `WECHAT_OAUTH_HTTP_TIMEOUT_MS` | 微信 HTTP 超时，默认 `5000`，范围 `1..5000` |
| `WECHAT_MINIAPP_ENABLED` | 默认 `false`；与 OAuth 独立启用 |
| `WECHAT_MINIAPP_APP_ID` / `WECHAT_MINIAPP_APP_SECRET` | 小程序 AppID / AppSecret，不要混用网站或公众号凭据 |
| `WECHAT_MINIAPP_CODE_TTL_SECONDS` | 授权码防重放保留秒数，默认 `300`，范围 `300..600` |
| `WECHAT_MINIAPP_HTTP_TIMEOUT_MS` | 小程序 HTTP 超时，默认 `5000`，范围 `1..5000` |

两个会员密钥必须彼此不同，且均不得与后台 `JWT_SECRET`、`REFRESH_TOKEN_SECRET` 相同。可分别运行 `openssl rand -base64 48` 生成；即使未启用微信，会员密钥仍为启动必填项。原有 `DB_*`、`REDIS_*`、后台 JWT 等配置继续按部署环境填写。

### 微信回调与前端白名单

在微信开放平台（网站模式）或公众号平台（公众号模式）配置与 `WECHAT_OAUTH_CALLBACK_URL` 相符的授权回调域名，外部 HTTPS 地址必须能到达服务端回调接口，反向代理应保留正确的前缀和查询参数。`website` 使用二维码 `qrconnect`；`official_account` 使用公众号网页授权 `oauth2/authorize`。回调地址由服务端配置固定，不能由客户端指定。

`WECHAT_OAUTH_RETURN_ORIGINS` 是**完整来源**精确匹配白名单（协议、主机和端口），每项不得带路径、尾部 `/`、查询或片段；不支持 `*` 或后缀匹配。`returnUrl` 可包含业务路径，但其来源必须在名单中，且不得包含用户名或密码。微信回调以 JSON 返回可信 `returnUrl` 和绑定结果或登录令牌，不做携带令牌的 302 跳转；前端消费响应后再导航。成功与失败回调都消耗 state，重复回调必须重新授权。API 与代理访问日志应隐藏微信 `code`、`state` 及所有令牌。

会员先用手机登录，再调用 `POST /member/social/wechat-oauth/bind-url` 绑定网页微信；以后用 `POST /member/auth/wechat/oauth-url` 发起微信登录。小程序用 `wx.login()` 的一次性 `code` 调用 `POST /member/social/wechat-miniapp/bind` 完成绑定，再用新 code 调用 `POST /member/auth/wechat-miniapp` 登录；服务端通过 `jscode2session` 交换身份。小程序只保存规范化身份，不保存或返回 `session_key`，代码在交换前先由 Redis 原子保留，失败或超时也不能重试相同 code。

两个渠道按 `(provider, tenant/AppID, subject/openid)` 区分身份，不能互换 AppID 或凭证。第三方登录只接受已绑定会员，未绑定身份不会自动注册。`unionid` 只用于发现冲突，绝不自动合并会员；绑定到其他会员的同一微信身份返回冲突，需要人工处理。`GET /member/social` 只返回安全绑定信息，解绑需先向当前会员手机号发送 `POST /member/social/unbind-sms`，再携带 `unbind` 验证码调用 `DELETE /member/social/:provider`；手机号登录保留。

### 短信发送器与限流

在 `src/modules/member-auth/member-auth.module.ts` 的 `SMS_SENDER` 注入点替换默认实现，实现 `SmsSender.sendCode(phone, purpose, code)`，将已生成的验证码交给短信供应商；供应商失败时应抛错，不得吞掉失败。此项目不自带厂商环境变量，所需凭据由集成方加入私有部署配置。默认发送器会失败关闭，不会把验证码写日志或返回给客户端。发送失败会删除未投递的验证码，发送配额仍保留；公开登录发送接口对未知、禁用手机号及供应商失败维持相同的成功响应，避免枚举账户。

`register`、`login`、`unbind` 验证码各自独立，6 位数字、有效期 300 秒、成功验证即删除，连续错误最多 5 次后作废。公开 `/member/auth/sms/:purpose` 只允许 register/login；解绑只能由当前会员发起。Redis 原子控制的发送限制跨用途共享：

| 维度 | 限额 |
| --- | --- |
| 手机号重发 | 每 60 秒最多 1 次 |
| 手机号 | 每 86400 秒最多 5 次 |
| 来源 IP | 每 86400 秒最多 20 次 |
| `X-Device-Id`（提供时） | 每 86400 秒最多 10 次 |

计数窗口从首次发送开始，不按自然日重置。手机号统一规范化为带 `+` 的号码；请求来源 IP 必须有效，设备 ID 可选且最多 256 字符。`X-Device-Id` 不是可信身份，不能代替手机号/IP 限额。应用还配置通用的每 IP/路由 60 秒 20 次请求限制；多实例或代理部署应确认通用限流存储与真实来源 IP 设置，而短信限制由共享 Redis 保证。不要为绕过限制而清空生产 Redis。

### 会话、权限与邀请团队

会员 access 是带 `aud=member`、`tokenType=access`、`sub`、`sessionId` 的 JWT；refresh 是 64 字符随机不透明令牌。数据库只保存 access 摘要和使用独立密钥的 refresh HMAC 摘要。会员与后台令牌不能跨接口使用，会员身份仅写入 `request.member`。会员允许多设备并存，原 `MULTI_DEVICE_LOGIN` 只控制后台用户；每次登录创建独立持久会话。

刷新会轮换 access/refresh，旧 access 立即失效。旧 refresh 再次使用会撤销其整个会话及最新轮换令牌，其他设备不受影响；客户端必须串行刷新，遇到网络不确定性应重新登录。`POST /member/auth/logout` 仅注销当前会话。管理员通过 `PUT /members/:id/status` 禁用或注销会员时，在同一事务中更新状态并撤销全部会话，任一步失败都会回滚。登录签发、刷新和状态调整按会员行、会话、refresh 的顺序加锁，防止并发登录逃过撤销；每次验证和刷新也会检查当前状态。禁用成功后所有旧令牌失效，重新启用不会恢复旧会话。后台操作权限为 `member:list`、`member:read`、`member:update-status`，按现有后台角色/菜单体系分配，超级管理员沿用已有权限规则。

会员资料只允许修改昵称、邮箱、头像。生产验证管道会剥离额外字段，拒绝无效数据时返回 422；`id`、手机号、邀请码、父级、状态不能通过会员资料接口改写。业务错误沿用项目约定的响应 `code`，部分业务错误 HTTP 状态仍为 200，客户端不能只判断 HTTP 状态。

邀请关系存于带索引的 `member.parent_id`，只在首次注册时写入。禁用/注销不会改链，删除父节点受外键保护。直属下级用普通索引查询；祖先及后代使用 **MySQL 8 的 WITH RECURSIVE**，不兼容 MySQL 5.7。当前会员为 level 0（不返回），直属为 level 1；默认深度 10、最大 100，路径去重避免自指或历史环无限递归。后代按层级、ID 稳定分页，页大小最大 100；计数与数据各执行一次查询，极端并发注册时不保证两次读取同一快照。团队接口不接受其他会员 ID，不返回手机号或第三方敏感标识。

### 可重复的隔离验收

普通测试使用 `pnpm exec jest --runInBand`（本项目 `pnpm test -- --runInBand` 的参数转发有问题）。完整流、会话并发撤销与递归 SQL 集成测试保存在 `src/modules/member/member-flow.e2e-spec.ts`，兼容 Node 20+，默认跳过；显式启用后只读取独立的 `MEMBER_TEST_MYSQL_URL`、`MEMBER_TEST_REDIS_URL`，不使用开发环境连接配置。测试自动创建随机 `member_acceptance_*` schema，运行三步迁移并在结束时删除；Redis 所有键带随机前缀，结束时只删除自身键，不使用 FLUSHDB。MySQL 测试账号需具备 CREATE/DROP DATABASE、测试库内 DDL/DML 和 CREATE TRIGGER 权限，并能读取 `performance_schema.data_locks` / `data_lock_waits` 来验证实际锁等待；务必指定可丢弃的测试实例。

下面的 PowerShell 命令启动独立端口的测试服务，口令仅供一次性本地容器。等待 MySQL 日志出现 `ready for connections` 后运行测试；结束后删除容器及其匿名卷：

```powershell
docker run -d --name member-acceptance-mysql -e MYSQL_ROOT_PASSWORD=member-disposable-test -p 127.0.0.1:13377:3306 mysql:8.4 --skip-log-bin
docker run -d --name member-acceptance-redis -p 127.0.0.1:16377:6379 redis:7-alpine
docker logs member-acceptance-mysql
$env:MEMBER_INTEGRATION = '1'
$env:MEMBER_TEST_MYSQL_URL = 'mysql://root:member-disposable-test@127.0.0.1:13377'
$env:MEMBER_TEST_REDIS_URL = 'redis://127.0.0.1:16377/0'
try {
  pnpm exec jest --runInBand src/modules/member/member-flow.e2e-spec.ts
} finally {
  Remove-Item Env:MEMBER_INTEGRATION, Env:MEMBER_TEST_MYSQL_URL, Env:MEMBER_TEST_REDIS_URL -ErrorAction SilentlyContinue
  docker rm -f -v member-acceptance-mysql member-acceptance-redis
}
```

覆盖无邀请 A、A 邀请 B、B 邀请 C、层级与分页、手机号登录、两种微信绑定/登录、验证码/state/code/refresh 重放、跨后台/会员令牌、管理员禁用后所有 B 会话持久撤销，以及父级关系保留。另有真实 MySQL 四层链、深度限制、空页、自指与环保护。微信仅在 HTTP 传输边界替换，短信仅替换外部投递，业务服务、守卫、数据库和 Redis Lua 均实际执行，不调用真实微信或短信。

### 回滚

优先关闭入口流量并回退应用版本、保留会员表与数据。停用微信可分别将 `WECHAT_OAUTH_ENABLED`、`WECHAT_MINIAPP_ENABLED` 设为 `false`，不会删除已有绑定。轮换会员 access 密钥会使所有旧 access 失效；同时轮换 refresh 密钥才能使旧 refresh 无法继续使用。

若确需撤回结构，先停止所有会员写入、备份四张会员表及迁移历史，确认 `AddMemberDomain1793080800000` 仍为最后一条已执行迁移，再在正确环境运行 `node ./node_modules/typeorm/cli.js -d ./dist/config/database.config.js migration:revert`。这一步依次删除 refresh、access、identity、member，**永久删除全部会员、邀请关系、绑定和会话**；不会删除后台用户表。不可反复执行 revert 撤销旧后台迁移。不要清空共享 Redis；测试键由测试自动回收，生产会员 SMS/state/code 键可等待其 TTL 过期。恢复会员功能需还原备份并核对迁移历史，或接受全新空会员库再重新迁移。

## 系统截图

![](https://s1.ax1x.com/2021/12/11/oTi1nf.png)

![](https://s1.ax1x.com/2021/12/11/oTithj.png)

![](https://s1.ax1x.com/2021/12/11/oTirHU.png)

![](https://s1.ax1x.com/2021/12/11/oTia3n.png)

### 欢迎 Star && PR

**如果项目有帮助到你可以点个 Star 支持下。有更好的实现欢迎 PR。**

### 致谢

- [sf-nest-admin](https://github.com/hackycy/sf-nest-admin)

### LICENSE

[MIT](LICENSE)
