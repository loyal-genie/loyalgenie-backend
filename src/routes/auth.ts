import { Router } from 'express'
import { createBusinessUser, signInBusiness, signToken } from '../services/auth.js'
import { z } from 'zod'

const router = Router()

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
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
    const token = signToken(user)

    res.status(201).json({
      success: true,
      data: { token, userId: user.id, email: user.email, onboarded: false },
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
