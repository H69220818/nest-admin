import { Exclude } from 'class-transformer'
import { BaseEntity, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Relation } from 'typeorm'

import { MemberAccessTokenEntity } from './member-access-token.entity'

@Exclude()
@Entity({ name: 'member_refresh_token' })
@Index('UQ_member_refresh_token_hash', ['tokenHash'], { unique: true })
@Index('IDX_member_refresh_token_access_token_id', ['accessTokenId'])
@Index('IDX_member_refresh_token_family_id', ['familyId'])
export class MemberRefreshTokenEntity extends BaseEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string

  @Column({ name: 'access_token_id', type: 'varchar', length: 36 })
  accessTokenId: string

  @ManyToOne(() => MemberAccessTokenEntity, token => token.refreshTokens, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'access_token_id', foreignKeyConstraintName: 'FK_member_refresh_token_access_token' })
  accessToken: Relation<MemberAccessTokenEntity>

  @Column({ name: 'family_id', type: 'varchar', length: 36 })
  familyId: string

  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash: string

  @Column({ name: 'expires_at', type: 'datetime' })
  expiresAt: Date

  @Column({ name: 'consumed_at', type: 'datetime', nullable: true })
  consumedAt: Date | null

  @Column({ name: 'revoked_at', type: 'datetime', nullable: true })
  revokedAt: Date | null

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date
}
