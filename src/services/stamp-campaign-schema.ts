import { z } from 'zod'
import { validateRedeemExpiryConfig } from '../utils/redeem-expiry.js'

const stampRewardEntryCore = {
  name: z.string().min(1),
  description: z.string().optional().default(''),
  icon: z.string().min(1).default('🎁'),
  winPercent: z.number().int().min(1).max(100),
  redeemExpiryMode: z.enum(['fixed', 'relative']),
  redeemFixedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  redeemRelativeAmount: z.number().int().min(1).optional(),
  redeemRelativeUnit: z.enum(['day', 'week', 'month']).optional(),
}

export const stampRewardEntrySchema = z.object(stampRewardEntryCore).superRefine((val, ctx) => {
  try {
    validateRedeemExpiryConfig(
      val.redeemExpiryMode,
      val.redeemFixedDate,
      val.redeemRelativeAmount,
      val.redeemRelativeUnit,
    )
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Redeem before is required for each reward' })
  }
})

export const stampDropSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  from: z.number().int().min(1),
  to: z.number().int().min(1),
  mode: z.enum(['single', 'pool']),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
})

export const stampConfigSchema = z.object({
  totalStamps: z.number().int().min(5).max(30),
  prefillStamps: z.number().int().min(0),
  surpriseDrops: z.array(stampDropSchema).min(1).max(8),
  bigRewards: z.array(stampDropSchema).min(1).max(8),
})

export type StampDrop = z.infer<typeof stampDropSchema>
export type StampConfig = z.infer<typeof stampConfigSchema>

type LegacyStampConfig = {
  totalStamps: number
  prefillStamps: number
  surpriseRange: [number, number]
  bigRange: [number, number]
  surpriseMode: 'single' | 'pool'
  bigMode: 'single' | 'pool'
}

export function normalizeStampConfig(raw: unknown): StampConfig {
  if (raw && typeof raw === 'object' && 'surpriseDrops' in (raw as object)) {
    return stampConfigSchema.parse(raw)
  }

  const legacy = raw as LegacyStampConfig
  return stampConfigSchema.parse({
    totalStamps: legacy.totalStamps,
    prefillStamps: legacy.prefillStamps ?? 0,
    surpriseDrops: [{
      id: 'surprise-0',
      label: 'Surprise Drop 1',
      from: legacy.surpriseRange[0],
      to: legacy.surpriseRange[1],
      mode: legacy.surpriseMode ?? 'single',
      color: '#F3E8FF',
    }],
    bigRewards: [{
      id: 'big-0',
      label: 'Big Reward 1',
      from: legacy.bigRange[0],
      to: legacy.bigRange[1],
      mode: legacy.bigMode ?? 'single',
      color: '#FEF3C7',
    }],
  })
}

export function stampRewardTierKey(tier: 'surprise' | 'big', dropId: string): string {
  if (dropId === 'surprise-0' && tier === 'surprise') return 'surprise'
  if (dropId === 'big-0' && tier === 'big') return 'big'
  return `${tier}:${dropId}`
}

export function parseStampRewardTier(rewardTier: string): { tier: 'surprise' | 'big'; dropId: string } | null {
  if (rewardTier === 'surprise') return { tier: 'surprise', dropId: 'surprise-0' }
  if (rewardTier === 'big') return { tier: 'big', dropId: 'big-0' }
  const surpriseMatch = rewardTier.match(/^surprise:(.+)$/)
  if (surpriseMatch) return { tier: 'surprise', dropId: surpriseMatch[1]! }
  const bigMatch = rewardTier.match(/^big:(.+)$/)
  if (bigMatch) return { tier: 'big', dropId: bigMatch[1]! }
  return null
}

export const createStampCampaignSchema = z.object({
  name: z.string().min(1),
  mechanic: z.literal('stamp'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('00:00'),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('23:59'),
  userCap: z.number().int().min(1),
  claimPeriodDays: z.number().int().min(1).max(365),
  stampConfig: stampConfigSchema,
  rewards: z.object({
    surprise: z.record(z.string(), z.array(stampRewardEntrySchema).min(1)),
    big: z.record(z.string(), z.array(stampRewardEntrySchema).min(1)),
  }),
})

export type CreateStampCampaignPayload = z.infer<typeof createStampCampaignSchema>
