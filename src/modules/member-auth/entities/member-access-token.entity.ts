import { Exclude } from 'class-transformer'
import { BaseEntity, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, Relation } from 'typeorm'

import { MemberEntity } from '~/modules/member/member.entity'

import { MemberRefreshTokenEntity } from './member-refresh-token.entity'

@Exclude()
@Entity({ name: 'member_access_token' })
@Index('UQ_member_access_token_hash', ['tokenHash'], { unique: true })
@Index('IDX_member_access_token_member_id', ['memberId'])
export class MemberAccessTokenEntity extends BaseEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string

  @Column({ name: 'member_id', type: 'int', unsigned: true })
  memberId: number

  @ManyToOne(() => MemberEntity, member => member.accessTokens, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'member_id', foreignKeyConstraintName: 'FK_member_access_token_member' })
  member: Relation<MemberEntity>

  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash: string

  @Column({ name: 'expires_at', type: 'datetime' })
  expiresAt: Date

  @Column({ name: 'revoked_at', type: 'datetime', nullable: true })
  revokedAt: Date | null

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date

  @OneToMany(() => MemberRefreshTokenEntity, token => token.accessToken)
  refreshTokens: Relation<MemberRefreshTokenEntity[]>
}
