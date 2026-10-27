import { BaseEntity, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Relation, UpdateDateColumn } from 'typeorm'

import { MemberIdentityProvider } from '~/modules/member/member.constant'
import { MemberEntity } from '~/modules/member/member.entity'

@Entity({ name: 'member_identity' })
@Index('UQ_member_identity_subject', ['provider', 'providerTenant', 'providerSubject'], { unique: true })
@Index('UQ_member_identity_binding', ['memberId', 'provider', 'providerTenant'], { unique: true })
export class MemberIdentityEntity extends BaseEntity {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int', unsigned: true })
  id: number

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date

  @Column({ name: 'member_id', type: 'int', unsigned: true })
  memberId: number

  @ManyToOne(() => MemberEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'member_id', foreignKeyConstraintName: 'FK_member_identity_member' })
  member: Relation<MemberEntity>

  @Column({ name: 'provider', type: 'varchar', length: 32 })
  provider: MemberIdentityProvider

  @Column({ name: 'provider_tenant', type: 'varchar', length: 128, collation: 'utf8mb4_bin' })
  providerTenant: string

  @Column({ name: 'provider_subject', type: 'varchar', length: 191, collation: 'utf8mb4_bin' })
  providerSubject: string

  @Column({ name: 'union_id', type: 'varchar', length: 191, nullable: true, collation: 'utf8mb4_bin' })
  unionId: string | null

  @Column({ name: 'display_name', type: 'varchar', length: 64, nullable: true })
  displayName: string | null

  @Column({ name: 'avatar', type: 'varchar', length: 500, nullable: true })
  avatar: string | null
}
