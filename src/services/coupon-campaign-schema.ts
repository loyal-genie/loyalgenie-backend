import { z } from 'zod'

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

const redeemFields = {
  redeemExpiryMode: z.enum(['fixed', 'relative']),
  redeemFixedDate: z.string().nullable().optional(),
  redeemRelativeAmount: z.number().int().optional(),
  redeemRelativeUnit: z.enum(['day', 'week', 'month']).optional(),
}

export const couponConfigSchema = z.object({
  totalCoupons: z.number().int().min(1).max(10_000).default(200),
  rewardKind: z.enum(['flat', 'percent']),
  rewardValue: z.string().min(1),
  termsAndConditions: z.string().default(''),
  ...redeemFields,
})

export type CouponConfig = z.infer<typeof couponConfigSchema>

export const createCouponCampaignSchema = z.object({
  name: z.string().min(1),
  mechanic: z.literal('coupon'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: timeSchema.default('00:00'),
  endTime: timeSchema.default('23:59'),
  couponConfig: couponConfigSchema,
})

export type CreateCouponCampaignPayload = z.infer<typeof createCouponCampaignSchema>

export function formatCouponRewardLabel(config: CouponConfig): string {
  const v = config.rewardValue.trim()
  switch (config.rewardKind) {
    case 'flat':
      return `₹${v} Off`
    case 'percent':
      return `${v}% Off`
    default:
      return v || 'Coupon'
  }
}

export function formatCouponSentence(config: CouponConfig): string {
  return `${config.totalCoupons} Coupons → ${formatCouponRewardLabel(config)}`
}

export function formatCouponDescription(config: CouponConfig): string {
  return `Limited coupon · ${formatCouponRewardLabel(config)}`
}

export function validateCouponConfig(config: CouponConfig): void {
  if (config.totalCoupons < 1) throw new Error('INVALID_COUPON_CONFIG')
  if (!config.rewardValue.trim()) throw new Error('INVALID_COUPON_CONFIG')
  if (config.rewardKind === 'percent') {
    const n = Number(config.rewardValue)
    if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error('INVALID_COUPON_CONFIG')
  }
  if (config.redeemExpiryMode === 'fixed' && !config.redeemFixedDate) {
    throw new Error('INVALID_COUPON_REDEEM')
  }
  if (config.redeemExpiryMode === 'relative' && (config.redeemRelativeAmount ?? 0) < 1) {
    throw new Error('INVALID_COUPON_REDEEM')
  }
}

export function parseCouponConfig(configJson: string | null): CouponConfig | null {
  if (!configJson) return null
  try {
    const parsed = JSON.parse(configJson) as { type?: string; couponConfig?: CouponConfig }
    if (parsed.type !== 'coupon' || !parsed.couponConfig) return null
    return couponConfigSchema.parse(parsed.couponConfig)
  } catch {
    return null
  }
}

export function serializeCouponConfig(config: CouponConfig): string {
  return JSON.stringify({ type: 'coupon', couponConfig: config })
}
