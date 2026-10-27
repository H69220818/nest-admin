export const SMS_PURPOSES = ['register', 'login', 'unbind'] as const
export type SmsPurpose = typeof SMS_PURPOSES[number]

export const SMS_SENDER = Symbol('MEMBER_SMS_SENDER')

/** Bind an implementation in MemberAuthModule; no SMS vendor is assumed here. */
export interface SmsSender {
  sendCode: (phone: string, purpose: SmsPurpose, code: string) => Promise<void>
}

export interface SmsRequestMeta {
  ip: string
  deviceId?: string
}

export const SMS_CODE_TTL_SECONDS = 300
export const SMS_RESEND_SECONDS = 60
export const SMS_RATE_WINDOW_SECONDS = 86_400
export const SMS_PHONE_SEND_LIMIT = 5
export const SMS_IP_SEND_LIMIT = 20
export const SMS_DEVICE_SEND_LIMIT = 10
export const SMS_MAX_CODE_ATTEMPTS = 5
