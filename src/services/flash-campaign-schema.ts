import { z } from 'zod'

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

const redeemFields = {
  redeemExpiryMode: z.enum(['fixed', 'relative']),
  redeemFixedDate: z.string().nullable().optional(),
  redeemRelativeAmount: z.number().int().optional(),
  redeemRelativeUnit: z.enum(['day', 'week', 'month']).optional(),
}

export const flashConfigSchema = z.object({
  totalSlots: z.number().int().min(1).max(5_000).default(50),
  rewardKind: z.enum(['flat', 'percent', 'item']),
  rewardValue: z.string().min(1),
  termsAndConditions: z.string().default(''),
  ...redeemFields,
})

export type FlashConfig = z.infer<typeof flashConfigSchema>

export const createFlashCampaignSchema = z.object({
  name: z.string().min(1),
  mechanic: z.literal('flash'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: timeSchema.default('00:00'),
  endTime: timeSchema.default('23:59'),
  flashConfig: flashConfigSchema,
})

export type CreateFlashCampaignPayload = z.infer<typeof createFlashCampaignSchema>

export function formatFlashRewardLabel(config: FlashConfig): string {
  const v = config.rewardValue.trim()
  switch (config.rewardKind) {
    case 'flat':
      return `₹${v} Off`
    case 'percent':
      return `${v}% Off`
    case 'item':
    default:
      return v || 'Flash Deal'
  }
}

export function formatFlashSentence(config: FlashConfig): string {
  return `${config.totalSlots} Spots → ${formatFlashRewardLabel(config)}`
}

export function formatFlashDescription(config: FlashConfig): string {
  return `Limited flash deal · ${formatFlashRewardLabel(config)}`
}

export function validateFlashConfig(config: FlashConfig): void {
  if (config.totalSlots < 1) throw new Error('INVALID_FLASH_CONFIG')
  if (!config.rewardValue.trim()) throw new Error('INVALID_FLASH_CONFIG')
  if (config.rewardKind === 'percent') {
    const n = Number(config.rewardValue)
    if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error('INVALID_FLASH_CONFIG')
  }
  if (config.redeemExpiryMode === 'fixed' && !config.redeemFixedDate) {
    throw new Error('INVALID_FLASH_REDEEM')
  }
  if (config.redeemExpiryMode === 'relative' && (config.redeemRelativeAmount ?? 0) < 1) {
    throw new Error('INVALID_FLASH_REDEEM')
  }
}

export function parseFlashConfig(configJson: string | null): FlashConfig | null {
  if (!configJson) return null
  try {
    const parsed = JSON.parse(configJson) as { type?: string; flashConfig?: FlashConfig }
    if (parsed.type !== 'flash' || !parsed.flashConfig) return null
    return flashConfigSchema.parse(parsed.flashConfig)
  } catch {
    return null
  }
}

export function serializeFlashConfig(config: FlashConfig): string {
  return JSON.stringify({ type: 'flash', flashConfig: config })
}
