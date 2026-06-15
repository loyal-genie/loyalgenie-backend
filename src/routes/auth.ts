import { Router } from 'express'
import { createBusinessUser, createCustomerUser, signInBusiness, signInCustomer, signToken, resetPasswordByEmail, verifyToken } from '../services/auth.js'
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

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

const customerSignUpSchema = z.object({
  name: z.string().min(2, 'Name is required'),
  phone: z.string().min(10, 'Valid phone number is required'),
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

router.post('/customer/forgot-password', forgotPasswordHandler('customer'))
router.post('/business/forgot-password', forgotPasswordHandler('business'))

router.post('/customer/signin', async (req, res) => {
  try {
    const parsed = signInSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(422).json({ error: 'Invalid email or password' })
    }

    const result = await signInCustomer(parsed.data.email, parsed.data.password)
    res.json({ success: true, data: result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'SIGNIN_FAILED'
    if (message === 'INVALID_CREDENTIALS') {
      return res.status(401).json({ error: 'Invalid email or password' })
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

    const user = await createCustomerUser(
      parsed.data.name,
      parsed.data.phone,
      parsed.data.email,
      parsed.data.password,
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
      return res.status(409).json({ error: 'An account with this email or phone already exists' })
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
