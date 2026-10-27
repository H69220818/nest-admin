import { BadRequestException, Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'

import { PagerDto } from '~/common/dto/pager.dto'
import { paginate } from '~/helper/paginate'
import { createPaginationObject } from '~/helper/paginate/create-pagination'
import { Pagination } from '~/helper/paginate/pagination'

import { MemberTeamRow } from './dto/member-team.dto'
import { MemberEntity } from './member.entity'

interface MemberTeamRawRow {
  id: number | string
  parentId: number | string | null
  nickname: string | null
  avatar: string | null
  level: number | string
}

@Injectable()
export class MemberTeamService {
  constructor(
    @InjectRepository(MemberEntity)
    private readonly members: Repository<MemberEntity>,
  ) {}

  async listDirect(memberId: number, pager: PagerDto): Promise<Pagination<MemberTeamRow>> {
    const options = this.paging(pager)
    const query = this.members.createQueryBuilder('member')
      .select(['member.id', 'member.parentId', 'member.nickname', 'member.avatar'])
      .where('member.parentId = :memberId', { memberId })
      .andWhere('member.id != :memberId', { memberId })
      .orderBy('member.id', 'ASC')
    const result = await paginate(query, options)
    const items = result.items.map(({ id, parentId, nickname, avatar }) => ({ id, parentId, nickname, avatar, level: 1 }))
    return new Pagination(items, result.meta)
  }

  async listAncestors(memberId: number, maxDepth = 10): Promise<MemberTeamRow[]> {
    const depth = this.depth(maxDepth)
    const rows: MemberTeamRawRow[] = await this.members.query(`${this.recursiveQuery('ancestors')}
      SELECT id, parent_id AS parentId, nickname, avatar, level
      FROM team WHERE level > 0 ORDER BY level ASC, id ASC`, [memberId, depth])
    return rows.map(row => this.toRow(row))
  }

  async listDescendants(memberId: number, maxDepth = 10, pager: PagerDto = {}): Promise<Pagination<MemberTeamRow>> {
    const depth = this.depth(maxDepth)
    const { page, pageSize } = this.paging(pager)
    const cte = this.recursiveQuery('descendants')
    const [count] = await this.members.query(`${cte}
      SELECT COUNT(*) AS total FROM team WHERE level > 0`, [memberId, depth])
    const rows: MemberTeamRawRow[] = await this.members.query(`${cte}
      SELECT id, parent_id AS parentId, nickname, avatar, level
      FROM team WHERE level > 0 ORDER BY level ASC, id ASC LIMIT ? OFFSET ?`, [memberId, depth, pageSize, (page - 1) * pageSize])
    return createPaginationObject({ items: rows.map(row => this.toRow(row)), totalItems: Number(count.total), currentPage: page, limit: pageSize })
  }

  private toRow(row: MemberTeamRawRow): MemberTeamRow {
    return {
      id: Number(row.id),
      parentId: row.parentId === null ? null : Number(row.parentId),
      nickname: row.nickname,
      avatar: row.avatar,
      level: Number(row.level),
    }
  }

  private depth(requested: number): number {
    if (!Number.isSafeInteger(requested) || requested < 1)
      throw new BadRequestException('团队查询层级无效')
    return Math.min(requested, 100)
  }

  private paging({ page = 1, pageSize = 10 }: PagerDto): { page: number, pageSize: number } {
    if (!Number.isInteger(page) || page < 1 || page > 2147483647
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new BadRequestException('团队查询分页参数无效')
    }
    return { page, pageSize }
  }

  private recursiveQuery(direction: 'ancestors' | 'descendants'): string {
    // Only this closed internal choice varies SQL; all caller values are bound.
    const relation = direction === 'ancestors' ? 'next.id = team.parent_id' : 'next.parent_id = team.id'
    // 101 unsigned INT IDs (10 digits + comma each) plus initial comma = 1112.
    // Seed with self at level zero, so even a corrupt cycle cannot return self.
    return `WITH RECURSIVE team AS (
      SELECT id, parent_id, nickname, avatar, 0 AS level,
        CAST(CONCAT(',', id, ',') AS CHAR(1112)) AS path
      FROM member WHERE id = ?
      UNION ALL
      SELECT next.id, next.parent_id, next.nickname, next.avatar, team.level + 1,
        CONCAT(team.path, next.id, ',')
      FROM member AS next INNER JOIN team ON ${relation}
      WHERE team.level < ? AND LOCATE(CONCAT(',', next.id, ','), team.path) = 0
    )`
  }
}
