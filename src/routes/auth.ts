import { Router } from 'express'
import {
  createBusinessUser,
  createCustomerUser,
  signInBusiness,
  signInCustomerByPhone,
  signToken,
  resetPasswordByEmail,
  verifyToken,
  getCustomerByPhone,
} from '../services/auth.js'
import { sendOtp, verifyOtp } from '../services/msg91.js'
import { toStoredPhone } from '../services/phone.js'
import { z } from 'zod'

const router = Router()

function bearerToken(req: import('express').Request): string | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return header.slice(7)
}

router.get('/session', (req, res) => {
  const token = bearerToken(req)
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  const user = verifyToken(token)
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
  res.json({
    success: true,
    data: {
      userId: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      phone: user.phone,
    },
  })
})

const phoneSchema = z.object({
  phone: z.string().min(10, 'Valid phone number is required'),
})

const otpSendSchema = phoneSchema.extend({
  purpose: z.enum(['signin', 'signup']),
})

const otpVerifySchema = phoneSchema.extend({
  otp: z.string().length(6, 'Enter the 6-digit OTP'),
})

const customerSignUpSchema = z.object({
  name: z.string().min(2, 'Name is required'),
  phone: z.string().min(10, 'Valid phone number is required'),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth is required'),
  email: z.string().email().optional().or(z.literal('')),
  otp: z.string().length(6, 'Enter the 6-digit OTP'),
})

const customerSignInSchema = z.object({
  phone: z.string().min(10, 'Valid phone number is required'),
  otp: z.string().length(6, 'Enter the 6-digit OTP'),
})

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

const forgotPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

function forgotPasswordHandler(role: 'business' | 'customer') {
  return async (req: import('express').Request, res: import('express').Response) => {
    try {
      const parsed = forgotPasswordSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(422).json({
          error: 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        })
      }

      await resetPasswordByEmail(role, parsed.data.email, parsed.data.password)
      res.json({ success: true, message: 'Password updated successfully' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'RESET_FAILED'
      if (message === 'EMAIL_NOT_FOUND') {
        return res.status(404).json({ error: 'No account found for this email' })
      }
      console.error('Forgot password error:', err)
      res.status(500).json({ error: 'Could not reset password' })
    }
  }
}

router.post('/business/forgot-password', forgotPasswordHandler('business'))

router.post('/otp/send', async (req, res) => {
  try {
    const parsed = otpSendSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(422).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      })
    }

    const storedPhone = toStoredPhone(parsed.data.phone)

    if (parsed.data.purpose === 'signin') {
      const existing = await getCustomerByPhone(storedPhone)
      if (!existing) {
        return res.status(422).json({ error: 'No account found for this mobile number. Please sign up first.', code: 'PHONE_NOT_FOUND' })
      }
    } else {
      const existing = await getCustomerByPhone(storedPhone)
      if (existing) {
        return res.status(409).json({ error: 'An account with this mobile number already exists. Please sign in.' })
      }
    }

    await sendOtp(parsed.data.phone)
    res.json({ success: true, message: 'OTP sent successfully' })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OTP_SEND_FAILED'
    if (message === 'INVALID_PHONE') {
      return res.status(422).json({ error: 'Enter a valid 10-digit Indian mobile number' })
    }
    if (message === 'MSG91_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'OTP service is not configured' })
    }
    if (message === 'MSG91_SENDER_ID_MISSING') {
      return res.status(503).json({
        error: 'MSG91 Sender ID is not configured. Add MSG91_SENDER_ID to backend .env (find it under MSG91 → SMS → Sender Id).',
      })
    }
    console.error('OTP send error:', err)
    res.status(500).json({ error: 'Could not send OTP. Please try again.' })
  }
})

router.post('/otp/verify', async (req, res) => {
  try {
    const parsed = otpVerifySchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(422).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      })
    }

    await verifyOtp(parsed.data.phone, parsed.data.otp)
    res.json({ success: true, message: 'OTP verified' })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OTP_VERIFY_FAILED'
    if (message === 'INVALID_PHONE') {
      return res.status(422).json({ error: 'Enter a valid 10-digit Indian mobile number' })
    }
    if (message === 'INVALID_OTP' || message.toLowerCase().includes('otp')) {
      return res.status(401).json({ error: 'Invalid or expired OTP. Please try again.' })
    }
    console.error('OTP verify error:', err)
    res.status(500).json({ error: 'Could not verify OTP. Please try again.' })
  }
})

router.post('/customer/signin', async (req, res) => {
  try {
    const parsed = customerSignInSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(422).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      })
    }

    await verifyOtp(parsed.data.phone, parsed.data.otp)
    const storedPhone = toStoredPhone(parsed.data.phone)
    const result = await signInCustomerByPhone(storedPhone)
    res.json({ success: true, data: result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'SIGNIN_FAILED'
    if (message === 'PHONE_NOT_FOUND') {
      return res.status(404).json({ error: 'No account found for this mobile number. Please sign up first.' })
    }
    if (message === 'INVALID_PHONE') {
      return res.status(422).json({ error: 'Enter a valid 10-digit Indian mobile number' })
    }
    if (message.toLowerCase().includes('otp') || message === 'INVALID_OTP') {
      return res.status(401).json({ error: 'Invalid or expired OTP. Please try again.' })
    }
    console.error('Customer signin error:', err)
    res.status(500).json({ error: 'Sign in failed' })
  }
})

router.post('/customer/signup', async (req, res) => {
  try {
    const parsed = customerSignUpSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(422).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      })
    }

    await verifyOtp(parsed.data.phone, parsed.data.otp)
    const storedPhone = toStoredPhone(parsed.data.phone)
    const email = parsed.data.email?.trim() || null

    const user = await createCustomerUser(
      parsed.data.name,
      storedPhone,
      parsed.data.dateOfBirth,
      email,
    )
    const token = signToken({ ...user, role: 'customer' })

    res.status(201).json({
      success: true,
      data: {
        token,
        userId: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        role: 'customer',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'SIGNUP_FAILED'
    if (message === 'EMAIL_OR_PHONE_EXISTS') {
      return res.status(409).json({ error: 'An account with this mobile number or email already exists' })
    }
    if (message === 'INVALID_PHONE') {
      return res.status(422).json({ error: 'Enter a valid 10-digit Indian mobile number' })
    }
    if (message.toLowerCase().includes('otp') || message === 'INVALID_OTP') {
      return res.status(401).json({ error: 'Invalid or expired OTP. Please try again.' })
    }
    console.error('Customer signup error:', err)
    res.status(500).json({ error: 'Sign up failed' })
  }
})

router.post('/business/signin', async (req, res) => {
  try {
    const parsed = signInSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(422).json({ error: 'Invalid email or password' })
    }

    const result = await signInBusiness(parsed.data.email, parsed.data.password)
    res.json({ success: true, data: result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'SIGNIN_FAILED'
    if (message === 'INVALID_CREDENTIALS') {
      return res.status(401).json({ error: 'Invalid email or password' })
    }
    console.error('Signin error:', err)
    res.status(500).json({ error: 'Sign in failed' })
  }
})

router.post('/business/signup', async (req, res) => {
  try {
    const parsed = signUpSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(422).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      })
    }

    const user = await createBusinessUser(parsed.data.email, parsed.data.password)
    const token = signToken({ ...user, role: 'business' })

    res.status(201).json({
      success: true,
      data: { token, userId: user.id, email: user.email, role: 'business', onboarded: false },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'SIGNUP_FAILED'
    if (message === 'EMAIL_EXISTS') {
      return res.status(409).json({ error: 'An account with this email already exists' })
    }
    console.error('Signup error:', err)
    res.status(500).json({ error: 'Sign up failed' })
  }
})

export default router
