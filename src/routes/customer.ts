import { Router } from 'express'
import { z } from 'zod'
import { requireCustomerAuth } from '../middleware/auth.js'
import {
  buildCustomerNotifications,
  getCustomerById,
  updateCustomerProfileFields,
} from '../services/customer.js'
import { signToken } from '../services/auth.js'

const router = Router()

const updateProfileSchema = z.object({
  name: z.string().min(2, 'Name is required').optional(),
  gender: z.enum(['male', 'female', 'other']).nullable().optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  email: z.string().email().nullable().optional().or(z.literal('')),
})

router.get('/profile', requireCustomerAuth, async (req, res) => {
  try {
    const profile = await getCustomerById(req.user!.id)
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }
    res.json({ success: true, data: profile })
  } catch (err) {
    console.error('Get customer profile error:', err)
    res.status(500).json({ error: 'Could not load profile' })
  }
})

router.patch('/profile', requireCustomerAuth, async (req, res) => {
  try {
    const parsed = updateProfileSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(422).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      })
    }

    const email = parsed.data.email === '' ? null : parsed.data.email
    const profile = await updateCustomerProfileFields(req.user!.id, {
      name: parsed.data.name,
      gender: parsed.data.gender,
      dateOfBirth: parsed.data.dateOfBirth,
      email,
    })
    const token = signToken({
      id: profile.id,
      email: profile.email,
      role: 'customer',
      name: profile.name,
      phone: profile.phone,
    })

    res.json({
      success: true,
      data: {
        profile,
        token,
        userId: profile.id,
        email: profile.email,
        name: profile.name,
        phone: profile.phone,
        role: 'customer',
        profileComplete: profile.profileComplete,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UPDATE_FAILED'
    if (message === 'EMAIL_EXISTS') {
      return res.status(409).json({ error: 'An account with this email already exists' })
    }
    console.error('Update customer profile error:', err)
    res.status(500).json({ error: 'Could not update profile' })
  }
})

router.get('/notifications', requireCustomerAuth, async (req, res) => {
  try {
    const profile = await getCustomerById(req.user!.id)
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }
    const notifications = buildCustomerNotifications(profile)
    res.json({ success: true, data: { notifications, unreadCount: notifications.length } })
  } catch (err) {
    console.error('Get customer notifications error:', err)
    res.status(500).json({ error: 'Could not load notifications' })
  }
})

export default router
