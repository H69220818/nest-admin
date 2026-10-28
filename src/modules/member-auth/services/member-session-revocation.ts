import { EntityManager } from 'typeorm'

import { MemberAccessTokenEntity } from '../entities/member-access-token.entity'
import { MemberRefreshTokenEntity } from '../entities/member-refresh-token.entity'

/** Caller holds the member row lock in the same transaction. */
export async function revokeLockedMemberSessions(manager: EntityManager, memberId: number): Promise<void> {
  const sessions = await manager.find(MemberAccessTokenEntity, {
    where: { memberId },
    order: { id: 'ASC' },
    lock: { mode: 'pessimistic_write' },
  })
  for (const session of sessions)
    await revokeLockedSession(manager, session.id)
}

/** Caller holds the member and session row locks; retain refresh replay evidence. */
export async function revokeLockedSession(manager: EntityManager, sessionId: string): Promise<void> {
  const revokedAt = new Date()
  await manager.update(MemberAccessTokenEntity, { id: sessionId }, { revokedAt })
  await manager.update(MemberRefreshTokenEntity, { accessTokenId: sessionId }, { revokedAt })
}
