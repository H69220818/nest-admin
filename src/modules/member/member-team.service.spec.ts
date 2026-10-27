import { CanActivate, ExecutionContext, ValidationPipe } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { Repository } from 'typeorm'

import { AUTH_ROUTE_KEY } from '~/modules/member-auth/decorators/member-auth.decorator'

import { MemberTeamController } from './member-team.controller'
import { MemberTeamService } from './member-team.service'
import { MemberEntity } from './member.entity'

// Query-boundary tests stay compatible with the project's Node >=20 runtime.
// The ignored task report records the separate live MySQL fixture verification.
describe('member team query boundary', () => {
  let service: MemberTeamService
  let repository: { createQueryBuilder: jest.Mock, query: jest.Mock }
  let directQuery: Record<string, jest.Mock>

  beforeEach(() => {
    directQuery = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([
        [{ id: 11, parentId: 1, nickname: 'Child', avatar: null, phone: 'private' }],
        2,
      ]),
    }
    repository = {
      createQueryBuilder: jest.fn(() => directQuery),
      query: jest.fn().mockResolvedValue([]),
    }
    service = new MemberTeamService(repository as unknown as Repository<MemberEntity>)
  })

  it('uses an ordinary indexed direct query, stable pagination and explicit safe level-one rows', async () => {
    expect(await service.listDirect(1, { page: 2, pageSize: 1 })).toEqual({
      items: [{ id: 11, parentId: 1, nickname: 'Child', avatar: null, level: 1 }],
      meta: { itemCount: 1, totalItems: 2, itemsPerPage: 1, totalPages: 2, currentPage: 2 },
    })
    expect(directQuery.where).toHaveBeenCalledWith('member.parentId = :memberId', { memberId: 1 })
    expect(directQuery.andWhere).toHaveBeenCalledWith('member.id != :memberId', { memberId: 1 })
    expect(directQuery.orderBy).toHaveBeenCalledWith('member.id', 'ASC')
    expect(directQuery.select).toHaveBeenCalledWith(['member.id', 'member.parentId', 'member.nickname', 'member.avatar'])
    expect(directQuery.take).toHaveBeenCalledWith(1)
    expect(directQuery.skip).toHaveBeenCalledWith(1)
    expect(repository.query).not.toHaveBeenCalled()
  })

  it('queries the four-level ancestor chain with bounded depth and explicit direct level', async () => {
    repository.query.mockResolvedValue([
      { id: 3, parentId: 2, nickname: null, avatar: null, level: 1 },
      { id: 2, parentId: 1, nickname: null, avatar: null, level: 2 },
      { id: 1, parentId: null, nickname: null, avatar: null, level: 3 },
    ])
    expect((await service.listAncestors(4, 100)).map(({ id, level }) => ({ id, level }))).toEqual([
      { id: 3, level: 1 },
      { id: 2, level: 2 },
      { id: 1, level: 3 },
    ])
    const [sql, parameters] = repository.query.mock.calls[0]
    expect(parameters).toEqual([4, 100])
    expect(sql).toMatch(/WITH RECURSIVE team/i)
    expect(sql).toContain('next.id = team.parent_id')
    expect(sql).toContain('team.level < ?')
    expect(sql).toContain('WHERE level > 0 ORDER BY level ASC, id ASC')
  })

  it('returns no ancestors when a root has no parent', async () => {
    await expect(service.listAncestors(1, 10)).resolves.toEqual([])
    expect(repository.query.mock.calls[0][1]).toEqual([1, 10])
  })

  it('uses the same depth-limited descendant CTE for the count and deterministic page', async () => {
    repository.query.mockResolvedValueOnce([{ total: '4' }]).mockResolvedValueOnce([
      { id: 3, parentId: 2, nickname: null, avatar: null, level: 2 },
      { id: 4, parentId: 3, nickname: null, avatar: null, level: 3 },
    ])
    const result = await service.listDescendants(1, 7, { page: 2, pageSize: 2 })
    expect(result.items.map(row => row.id)).toEqual([3, 4])
    expect(result.meta).toEqual({ itemCount: 2, totalItems: 4, itemsPerPage: 2, totalPages: 2, currentPage: 2 })
    const [[countSql, countParameters], [pageSql, pageParameters]] = repository.query.mock.calls
    expect(countParameters).toEqual([1, 7])
    expect(pageParameters).toEqual([1, 7, 2, 2])
    expect(countSql.split('SELECT COUNT(*)')[0]).toBe(pageSql.split('SELECT id, parent_id AS parentId')[0])
    expect(pageSql).toContain('next.parent_id = team.id')
    expect(pageSql).toContain('team.level < ?')
    expect(pageSql).toContain('WHERE level > 0 ORDER BY level ASC, id ASC LIMIT ? OFFSET ?')
  })

  it('preserves total metadata for an empty out-of-range page', async () => {
    repository.query.mockResolvedValueOnce([{ total: '4' }]).mockResolvedValueOnce([])
    expect((await service.listDescendants(1, 2, { page: 5, pageSize: 2 })).meta).toEqual({
      itemCount: 0,
      totalItems: 4,
      itemsPerPage: 2,
      totalPages: 2,
      currentPage: 5,
    })
  })

  it.each(['ancestors', 'descendants'])('excludes repeated nodes in %s with a root-seeded delimiter path sized for 101 unsigned INT IDs', async (direction) => {
    if (direction === 'ancestors') {
      await service.listAncestors(4294967295, 1000)
    }
    else {
      repository.query.mockResolvedValueOnce([{ total: '0' }]).mockResolvedValueOnce([])
      await service.listDescendants(4294967295, 1000, {})
    }
    const [sql, parameters] = repository.query.mock.calls[0]
    expect(parameters).toEqual([4294967295, 100])
    expect(sql).not.toContain('4294967295')
    expect(sql).toContain('CAST(CONCAT(\',\', id, \',\') AS CHAR(1112)) AS path')
    expect(sql).toContain('0 AS level')
    expect(sql).toContain('FROM member WHERE id = ?')
    expect(sql).toContain('CONCAT(team.path, next.id, \',\')')
    expect(sql).toContain('LOCATE(CONCAT(\',\', next.id, \',\'), team.path) = 0')
  })

  it('normalizes MySQL recursive numeric strings and projects only safe fields', async () => {
    const row = { id: '4294967295', parentId: '11', nickname: 'Team', avatar: null, level: '1', path: ',42,4294967295,', phone: 'private' }
    repository.query.mockResolvedValueOnce([row])
    expect(await service.listAncestors(42, 10)).toEqual([{ id: 4294967295, parentId: 11, nickname: 'Team', avatar: null, level: 1 }])
    repository.query.mockResolvedValueOnce([{ total: '1' }]).mockResolvedValueOnce([{ ...row, parentId: null }])
    expect((await service.listDescendants(42, 10, {})).items).toEqual([{ id: 4294967295, parentId: null, nickname: 'Team', avatar: null, level: 1 }])
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid service depth %s', async (maxDepth) => {
    await expect(service.listAncestors(1, maxDepth)).rejects.toThrow()
    await expect(service.listDescendants(1, maxDepth, {})).rejects.toThrow()
    expect(repository.query).not.toHaveBeenCalled()
  })

  it.each([{ page: 0 }, { page: 1.5 }, { page: 2147483648 }, { pageSize: 101 }, { pageSize: 0 }])('rejects invalid service pagination %p', async (pager) => {
    await expect(service.listDirect(1, pager)).rejects.toThrow()
    await expect(service.listDescendants(1, 10, pager)).rejects.toThrow()
  })
})

class MemberRequestGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest()
    request.member = { sub: '42', aud: 'member' }
    request.user = { uid: 99 }
    return true
  }
}

describe('member-owned team HTTP boundary', () => {
  let app: NestFastifyApplication
  const calls: unknown[][] = []

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MemberTeamController],
      providers: [
        { provide: MemberTeamService, useValue: {
          listDirect: async (...args) => {
            calls.push(args)
            return { items: [], meta: {} }
          },
          listAncestors: async (...args) => {
            calls.push(args)
            return []
          },
          listDescendants: async (...args) => {
            calls.push(args)
            return { items: [], meta: {} }
          },
        } },
        { provide: APP_GUARD, useClass: MemberRequestGuard },
      ],
    }).compile()
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  beforeEach(() => {
    calls.length = 0
  })
  afterAll(async () => app?.close())

  it.each(['direct', 'ancestors', 'descendants'])('uses request.member for %s with bounded defaults', async (route) => {
    expect((await app.inject({ method: 'GET', url: `/member/team/${route}` })).statusCode).toBe(200)
    expect(calls[0][0]).toBe(42)
    if (route !== 'direct')
      expect(calls[0][1]).toBe(10)
  })

  it('keeps member-only auth and protected Swagger security metadata', () => {
    expect(Reflect.getMetadata(AUTH_ROUTE_KEY, MemberTeamController)).toBe('member')
    expect(Reflect.getMetadata('swagger/apiSecurity', MemberTeamController)).toEqual([{ auth: [] }])
  })

  it.each([
    'page=0',
    'page=-1',
    'page=1.5',
    'page=2x',
    'page=1e100',
    'pageSize=0',
    'pageSize=101',
    'pageSize=1.1',
    'pageSize=2x',
    'maxDepth=0',
    'maxDepth=-1',
    'maxDepth=101',
    'maxDepth=1.5',
    'maxDepth=2x',
    'memberId=99',
    'id=99',
  ])('rejects malformed or out-of-bounds descendants query %s', async (query) => {
    expect((await app.inject({ method: 'GET', url: `/member/team/descendants?${query}` })).statusCode).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('passes validated numeric paging and depth', async () => {
    expect((await app.inject({ method: 'GET', url: '/member/team/descendants?page=2&pageSize=3&maxDepth=100' })).statusCode).toBe(200)
    expect(calls[0]).toEqual([42, 100, expect.objectContaining({ page: 2, pageSize: 3, maxDepth: 100 })])
  })
})
