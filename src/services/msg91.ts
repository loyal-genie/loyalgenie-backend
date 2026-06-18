import { generateOtp, saveOtp, verifyStoredOtp } from './otp-store.js'
import { normalizeIndianPhone, formatPhoneLocal } from './phone.js'

export { normalizeIndianPhone, formatPhoneLocal }

/** Official MSG91 Send SMS (Flow / Template) API — for SMS templates with ##var1## */
const MSG91_SMS_URLS = [
  'https://api.msg91.com/api/v5/flow',
  'https://control.msg91.com/api/v5/flow',
]

const MSG91_OTP_URL = 'https://control.msg91.com/api/v5/otp'

function getConfig() {
  const authKey = process.env.MSG91_AUTH_KEY?.trim().split(/\s+#/)[0]?.trim()
  const templateId = process.env.MSG91_OTP_TEMPLATE_ID?.trim().split(/\s+#/)[0]?.trim()
  const senderId = process.env.MSG91_SENDER_ID?.trim().split(/\s+#/)[0]?.trim()
  const otpLength = process.env.MSG91_OTP_LENGTH?.trim().split(/\s+#/)[0]?.trim() || '6'
  const otpExpiry = process.env.MSG91_OTP_EXPIRY?.trim().split(/\s+#/)[0]?.trim() || '10'
  const route = process.env.MSG91_ROUTE?.trim().split(/\s+#/)[0]?.trim() || '4'
  const apiMode = (process.env.MSG91_API_MODE?.trim() || 'sms').toLowerCase()
  return { authKey, templateId, senderId, otpLength, otpExpiry, route, apiMode }
}

export function isMsg91Configured(): boolean {
  if (process.env.MSG91_DEV_OTP === 'true') return false
  const { authKey, templateId } = getConfig()
  if (!authKey || !templateId) return false
  if (authKey.includes('your_auth_key') || templateId.includes('your_template')) return false
  return true
}

type Msg91Response = { type?: string; message?: string; request_id?: string }

async function postMsg91(url: string, authKey: string, body: Record<string, unknown>): Promise<{ status: number; data: Msg91Response }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authkey: authKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as Msg91Response
  return { status: res.status, data }
}

/**
 * Send OTP via MSG91 SMS Template API.
 * Docs: https://docs.msg91.com/sms/send-sms
 * API:  https://api.msg91.com/apidoc/textsms/send-sms-flow.php
 *
 * Your LoyalGenie-OTP template uses ##var1## — this requires the SMS/Flow API,
 * NOT the OTP Widget API (/api/v5/otp) which only accepts ##OTP## templates.
 */
async function sendOtpViaSmsTemplate(mobile: string, otp: string): Promise<void> {
  const { authKey, templateId, senderId, route } = getConfig()
  if (!senderId) {
    throw new Error('MSG91_SENDER_ID_MISSING')
  }

  const recipient: Record<string, string> = { mobiles: mobile, var1: otp }
  const payload: Record<string, unknown> = {
    template_id: templateId,
    short_url: '0',
    route,
    sender: senderId,
    recipients: [recipient],
  }

  let lastError = 'OTP_SEND_FAILED'

  for (const url of MSG91_SMS_URLS) {
    const { status, data } = await postMsg91(url, authKey!, payload)
    console.log(`[MSG91 SMS] send → ${mobile} | ${url} | HTTP ${status} |`, JSON.stringify(data))

    if (status >= 200 && status < 300 && data.type === 'success') {
      return
    }

    lastError = data.message || lastError

    // Retry uppercase VAR1 if lowercase var1 was rejected
    if (data.message?.toLowerCase().includes('variable') || data.message?.toLowerCase().includes('var')) {
      const upperPayload = {
        ...payload,
        recipients: [{ mobiles: mobile, VAR1: otp }],
      }
      const retry = await postMsg91(url, authKey!, upperPayload)
      console.log(`[MSG91 SMS] retry VAR1 → ${mobile} | HTTP ${retry.status} |`, JSON.stringify(retry.data))
      if (retry.status >= 200 && retry.status < 300 && retry.data.type === 'success') {
        return
      }
      lastError = retry.data.message || lastError
    }
  }

  console.error('MSG91 SMS send failed:', lastError)
  throw new Error(lastError)
}

async function sendOtpViaWidget(mobile: string): Promise<void> {
  const { authKey, templateId, otpLength, otpExpiry } = getConfig()
  const url = `${MSG91_OTP_URL}?template_id=${encodeURIComponent(templateId!)}&mobile=${mobile}&otp_length=${otpLength}&otp_expiry=${otpExpiry}`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authkey: authKey!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })

  const data = (await res.json()) as Msg91Response
  console.log(`[MSG91 OTP Widget] send → ${mobile} | HTTP ${res.status} |`, JSON.stringify(data))

  if (!res.ok || data.type !== 'success') {
    console.error('MSG91 OTP Widget send failed:', data)
    throw new Error(data.message || 'OTP_SEND_FAILED')
  }
}

export async function sendOtp(phone: string): Promise<void> {
  const mobile = normalizeIndianPhone(phone)

  if (!isMsg91Configured()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MSG91_NOT_CONFIGURED')
    }
    await saveOtp(phone, '123456')
    console.log(`[dev] OTP for ${mobile}: 123456`)
    return
  }

  const { apiMode } = getConfig()
  const otp = generateOtp()
  await saveOtp(phone, otp)

  if (apiMode === 'widget') {
    await sendOtpViaWidget(mobile)
  } else {
    await sendOtpViaSmsTemplate(mobile, otp)
  }
}

export async function verifyOtp(phone: string, otp: string): Promise<void> {
  if (!isMsg91Configured()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MSG91_NOT_CONFIGURED')
    }
    if (otp !== '123456') throw new Error('INVALID_OTP')
    return
  }

  const { apiMode } = getConfig()

  if (apiMode === 'widget') {
    const mobile = normalizeIndianPhone(phone)
    const { authKey } = getConfig()
    const url = `${MSG91_OTP_URL}/verify?mobile=${mobile}&otp=${encodeURIComponent(otp)}`

    const res = await fetch(url, {
      method: 'GET',
      headers: { authkey: authKey! },
    })

    const data = (await res.json()) as Msg91Response
    const ok = data.type === 'success' || data.message === 'OTP verified success'
    if (!ok) {
      throw new Error(data.message || 'INVALID_OTP')
    }
    return
  }

  const valid = await verifyStoredOtp(phone, otp)
  if (!valid) {
    throw new Error('INVALID_OTP')
  }
}
