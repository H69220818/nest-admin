import { AppConfig, appRegToken, IAppConfig } from './app.config'
import { DatabaseConfig, dbRegToken, IDatabaseConfig } from './database.config'
import { IMailerConfig, MailerConfig, mailerRegToken } from './mailer.config'
import { IMemberAuthConfig, MemberAuthConfig, memberAuthRegToken } from './member-auth.config'
import { IOssConfig, OssConfig, ossRegToken } from './oss.config'
import { IRedisConfig, RedisConfig, redisRegToken } from './redis.config'
import { ISecurityConfig, SecurityConfig, securityRegToken } from './security.config'
import { ISwaggerConfig, SwaggerConfig, swaggerRegToken } from './swagger.config'

export * from './app.config'
export * from './database.config'
export * from './mailer.config'
export * from './member-auth.config'
export * from './oss.config'
export * from './redis.config'
export * from './security.config'
export * from './swagger.config'

export interface AllConfigType {
  [appRegToken]: IAppConfig
  [dbRegToken]: IDatabaseConfig
  [mailerRegToken]: IMailerConfig
  [memberAuthRegToken]: IMemberAuthConfig
  [redisRegToken]: IRedisConfig
  [securityRegToken]: ISecurityConfig
  [swaggerRegToken]: ISwaggerConfig
  [ossRegToken]: IOssConfig
}

export type ConfigKeyPaths = RecordNamePaths<AllConfigType>

export default {
  AppConfig,
  DatabaseConfig,
  MailerConfig,
  MemberAuthConfig,
  OssConfig,
  RedisConfig,
  SecurityConfig,
  SwaggerConfig,
}
