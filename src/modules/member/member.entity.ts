import { Exclude } from 'class-transformer'
import { BaseEntity, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, Relation, UpdateDateColumn } from 'typeorm'

import { MemberAccessTokenEntity } from '~/modules/member-auth/entities/member-access-token.entity'

import { MemberStatus } from './member.constant'

@Entity({ name: 'member' })
@Index('UQ_member_phone', ['phone'], { unique: true })
@Index('UQ_member_invite_code', ['inviteCode'], { unique: true })
@Index('IDX_member_parent_id', ['parentId'])
export class MemberEntity extends BaseEntity {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int', unsigned: true })
  id: number

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date

  @Column({ name: 'parent_id', type: 'int', unsigned: true, nullable: true })
  parentId: number | null

  @ManyToOne(() => MemberEntity, member => member.children, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'parent_id', foreignKeyConstraintName: 'FK_member_parent' })
  parent: Relation<MemberEntity> | null

  @OneToMany(() => MemberEntity, member => member.parent)
  children: Relation<MemberEntity[]>

  @Column({ name: 'invite_code', type: 'varchar', length: 16 })
  inviteCode: string

  @Column({ name: 'phone', type: 'varchar', length: 32 })
  phone: string

  @Column({ name: 'phone_verified_at', type: 'datetime' })
  phoneVerifiedAt: Date

  @Column({ name: 'email', type: 'varchar', length: 255, nullable: true })
  email: string | null

  @Column({ name: 'nickname', type: 'varchar', length: 64, nullable: true })
  nickname: string | null

  @Column({ name: 'avatar', type: 'varchar', length: 500, nullable: true })
  avatar: string | null

  @Column({ name: 'status', type: 'tinyint', default: MemberStatus.Enabled })
  status: MemberStatus

  @Exclude()
  @OneToMany(() => MemberAccessTokenEntity, token => token.member)
  accessTokens: Relation<MemberAccessTokenEntity[]>
}
