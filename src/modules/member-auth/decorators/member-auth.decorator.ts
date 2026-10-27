import { SetMetadata } from '@nestjs/common'

export const AUTH_ROUTE_KEY = '__auth_route__'
export type AuthRouteType = 'public' | 'admin' | 'member'

/** Explicit audience metadata takes precedence over legacy admin Public metadata. */
export const AuthRoute = (type: AuthRouteType) => SetMetadata(AUTH_ROUTE_KEY, type)
export const MemberAuth = () => AuthRoute('member')
export const PublicAuth = () => AuthRoute('public')
export const AdminAuth = () => AuthRoute('admin')
