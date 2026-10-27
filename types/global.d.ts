declare global {
  interface IMemberAuthUser {
    sub: string
    aud: 'member'
    tokenType: 'access'
    sessionId: string
    /** Random per-issuance version; the persisted session hash is authoritative. */
    pv: number
    exp?: number
    iat?: number
  }

  interface IAuthUser {
    uid: number
    pv: number
    /** 过期时间 */
    exp?: number
    /** 签发时间 */
    iat?: number
    roles?: string[]
  }

  export interface IBaseResponse<T = any> {
    message: string
    code: number
    data?: T
  }

  export interface IListRespData<T = any> {
    items: T[]
  }
}

export {}
