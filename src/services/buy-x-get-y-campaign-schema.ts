import { z } from 'zod'

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

const redeemFields = {
  redeemExpiryMode: z.enum(['fixed', 'relative']),
  redeemFixedDate: z.string().nullable().optional(),
  redeemRelativeAmount: z.number().int().optional(),
  redeemRelativeUnit: z.enum(['day', 'week', 'month']).optional(),
}

export const buyXGetYConfigSchema = z.object({
  condition: z.enum(['quantity', 'spend']),
  buyQuantity: z.number().int().min(1).default(3),
  spendAmount: z.number().int().min(1).default(500),
  rewardKind: z.enum(['flat', 'percent', 'item']),
  rewardValue: z.string().min(1),
  ...redeemFields,
})

export type BuyXGetYConfig = z.infer<typeof buyXGetYConfigSchema>

export const createBuyXGetYCampaignSchema = z.object({
  name: z.string().min(1),
  mechanic: z.literal('buy-x-get-y'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: timeSchema.default('00:00'),
  endTime: timeSchema.default('23:59'),
  userCap: z.number().int().min(1).max(1_000_000).default(200),
  buyXGetYConfig: buyXGetYConfigSchema,
})

export type CreateBuyXGetYCampaignPayload = z.infer<typeof createBuyXGetYCampaignSchema>

export function formatBuyXGetYRewardLabel(config: BuyXGetYConfig): string {
  const v = config.rewardValue.trim()
  switch (config.rewardKind) {
    case 'flat':
      return `₹${v} Off`
    case 'percent':
      return `${v}% Off`
    case 'item':
    default:
      return v || 'Free Item'
  }
}

export function formatBuyXGetYSentence(config: BuyXGetYConfig): string {
  const reward = formatBuyXGetYRewardLabel(config)
  if (config.condition === 'spend') {
    return `Spend ₹${config.spendAmount} → Get ${reward.replace(/^Get /, '')}`
  }
  return `Buy ${config.buyQuantity} purchases → Get ${reward.replace(/^Get /, '')}`
}

export function formatBuyXGetYDescription(config: BuyXGetYConfig): string {
  if (config.condition === 'spend') {
    return `Spend ₹${config.spendAmount} in a single visit and get ${formatBuyXGetYRewardLabel(config).toLowerCase()}.`
  }
  return `Complete ${config.buyQuantity} purchases and get ${formatBuyXGetYRewardLabel(config).toLowerCase()}.`
}

export function validateBuyXGetYConfig(config: BuyXGetYConfig): void {
  if (config.condition === 'quantity' && config.buyQuantity < 1) {
    throw new Error('INVALID_BUY_X_GET_Y_CONFIG')
  }
  if (config.condition === 'spend' && config.spendAmount < 1) {
    throw new Error('INVALID_BUY_X_GET_Y_CONFIG')
  }
  if (!config.rewardValue.trim()) {
    throw new Error('INVALID_BUY_X_GET_Y_CONFIG')
  }
  if (config.rewardKind === 'percent') {
    const n = Number(config.rewardValue)
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      throw new Error('INVALID_BUY_X_GET_Y_CONFIG')
    }
  }
  if (config.redeemExpiryMode === 'fixed' && !config.redeemFixedDate) {
    throw new Error('INVALID_BUY_X_GET_Y_REDEEM')
  }
  if (config.redeemExpiryMode === 'relative' && (config.redeemRelativeAmount ?? 0) < 1) {
    throw new Error('INVALID_BUY_X_GET_Y_REDEEM')
  }
}

export function parseBuyXGetYConfig(configJson: string | null): BuyXGetYConfig | null {
  if (!configJson) return null
  try {
    const parsed = JSON.parse(configJson) as { type?: string; buyXGetYConfig?: BuyXGetYConfig }
    if (parsed.type !== 'buy-x-get-y' || !parsed.buyXGetYConfig) return null
    return buyXGetYConfigSchema.parse(parsed.buyXGetYConfig)
  } catch {
    return null
  }
}

export function serializeBuyXGetYConfig(config: BuyXGetYConfig): string {
  return JSON.stringify({ type: 'buy-x-get-y', buyXGetYConfig: config })
}
