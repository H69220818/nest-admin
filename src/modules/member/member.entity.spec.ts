import { instanceToPlain } from 'class-transformer'
import { DataSource, EntityMetadata } from 'typeorm'
import { MemberAccessTokenEntity } from '../member-auth/entities/member-access-token.entity'

import { MemberRefreshTokenEntity } from '../member-auth/entities/member-refresh-token.entity'
import { MemberIdentityEntity } from '../member-social/member-identity.entity'
import { MemberEntity } from './member.entity'
import 'reflect-metadata'

class MetadataDataSource extends DataSource {
  async build() {
    await this.buildMetadatas()
  }
}

describe('member schema', () => {
  const source = new MetadataDataSource({
    type: 'mysql',
    database: 'member_schema_test',
    entities: [MemberEntity, MemberIdentityEntity, MemberAccessTokenEntity, MemberRefreshTokenEntity],
  })
  let member: EntityMetadata
  let identity: EntityMetadata
  let access: EntityMetadata
  let refresh: EntityMetadata

  beforeAll(async () => {
    await source.build()
    member = source.getMetadata(MemberEntity)
    identity = source.getMetadata(MemberIdentityEntity)
    access = source.getMetadata(MemberAccessTokenEntity)
    refresh = source.getMetadata(MemberRefreshTokenEntity)
  })

  it('keeps all four member tables separate from administrator tables', () => {
    expect([member.tableName, identity.tableName, access.tableName, refresh.tableName])
      .toEqual(['member', 'member_identity', 'member_access_token', 'member_refresh_token'])
  })

  it('enforces unique normalized phone and invite code', () => {
    const uniqueColumns = member.indices.filter(index => index.isUnique)
      .map(index => index.columns.map(column => column.databaseName))
    expect(uniqueColumns).toEqual(expect.arrayContaining([['phone'], ['invite_code']]))
    expect(member.findColumnWithPropertyName('phone')).toMatchObject({ length: '32', isNullable: false })
    expect(member.findColumnWithPropertyName('inviteCode')).toMatchObject({ length: '16', isNullable: false })
  })

  it('allows a root member and indexes a restricted direct parent foreign key', () => {
    expect(member.findColumnWithPropertyName('parentId')).toMatchObject({ databaseName: 'parent_id', isNullable: true })
    expect(member.indices.some(index => index.columns.map(column => column.databaseName).join() === 'parent_id')).toBe(true)
    expect(member.foreignKeys).toEqual(expect.arrayContaining([expect.objectContaining({
      columnNames: ['parent_id'],
      referencedTablePath: 'member',
      referencedColumnNames: ['id'],
      onDelete: 'RESTRICT',
    })]))
  })

  it('uses compatible unsigned numeric member IDs on every relationship', () => {
    for (const column of [
      member.findColumnWithPropertyName('id'),
      member.findColumnWithPropertyName('parentId'),
      identity.findColumnWithPropertyName('memberId'),
      access.findColumnWithPropertyName('memberId'),
    ]) {
      expect(column).toMatchObject({ type: 'int', unsigned: true })
    }
  })

  it('enforces identity ownership and one binding per member/provider/tenant', () => {
    const uniqueColumns = identity.indices.filter(index => index.isUnique)
      .map(index => index.columns.map(column => column.databaseName))
    expect(uniqueColumns).toEqual(expect.arrayContaining([
      ['provider', 'provider_tenant', 'provider_subject'],
      ['member_id', 'provider', 'provider_tenant'],
    ]))
    expect(identity.foreignKeys[0]).toMatchObject({
      columnNames: ['member_id'],
      referencedTablePath: 'member',
      onDelete: 'RESTRICT',
    })
  })

  it('cascades member session deletion and retains multiple refresh generations', () => {
    expect(access.foreignKeys[0]).toMatchObject({
      columnNames: ['member_id'],
      referencedTablePath: 'member',
      onDelete: 'CASCADE',
    })
    expect(refresh.foreignKeys[0]).toMatchObject({
      columnNames: ['access_token_id'],
      referencedTablePath: 'member_access_token',
      onDelete: 'CASCADE',
    })
    expect(refresh.findRelationWithPropertyPath('accessToken').isManyToOne).toBe(true)
    expect(refresh.findColumnWithPropertyName('consumedAt')).toMatchObject({ databaseName: 'consumed_at', isNullable: true })
    expect(access.findColumnWithPropertyName('revokedAt')).toMatchObject({ databaseName: 'revoked_at', isNullable: true })
  })

  it('uses explicit snake_case database names for every persisted property', () => {
    for (const metadata of source.entityMetadatas) {
      for (const column of metadata.columns)
        expect(column.databaseName).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('never serializes session secrets or nested member tokens', () => {
    const token = Object.assign(new MemberAccessTokenEntity(), { tokenHash: 'access-secret-hash' })
    const refreshToken = Object.assign(new MemberRefreshTokenEntity(), { tokenHash: 'refresh-secret-hash' })
    const profile = Object.assign(new MemberEntity(), { nickname: 'Member', accessTokens: [token] })
    expect(instanceToPlain(token)).toEqual({})
    expect(instanceToPlain(refreshToken)).toEqual({})
    expect(instanceToPlain(profile)).toEqual({ nickname: 'Member' })
  })
})
