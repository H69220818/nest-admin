/** Internal registration input. Resolve parentId from an enabled inviter on the server. */
export interface CreateRegisteredMemberInput {
  phone: string
  phoneVerifiedAt: Date
  parentId?: number | null
  nickname?: string | null
  email?: string | null
  avatar?: string | null
}
