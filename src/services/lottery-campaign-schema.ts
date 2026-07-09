import { z } from 'zod'

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

const redeemFields = {
  redeemExpiryMode: z.enum(['fixed', 'relative']),
  redeemFixedDate: z.string().nullable().optional(),
  redeemRelativeAmount: z.number().int().optional(),
  redeemRelativeUnit: z.enum(['day', 'week', 'month']).optional(),
}

export const lotteryPrizeSchema = z.object({
  id: z.string().optional(),
  tier: z.enum(['jackpot', 'prize']),
  name: z.string().min(1),
  reward: z.string().min(1),
  description: z.string().optional().default(''),
  icon: z.string().optional().default('🎁'),
})

export const lotteryConfigSchema = z.object({
  prizes: z.array(lotteryPrizeSchema).min(1),
  drawCompleted: z.boolean().optional().default(false),
  drawCompletedAt: z.string().nullable().optional(),
  ...redeemFields,
})

export type LotteryConfig = z.infer<typeof lotteryConfigSchema>
export type LotteryPrize = z.infer<typeof lotteryPrizeSchema>

export const createLotteryCampaignSchema = z.object({
  name: z.string().min(1),
  mechanic: z.literal('lottery'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: timeSchema.default('00:00'),
  endTime: timeSchema.default('23:59'),
  lotteryConfig: lotteryConfigSchema,
})

export type CreateLotteryCampaignPayload = z.infer<typeof createLotteryCampaignSchema>

export function validateLotteryConfig(config: LotteryConfig): void {
  const jackpot = config.prizes.find(p => p.tier === 'jackpot')
  if (!jackpot || !jackpot.reward.trim()) {
    throw new Error('INVALID_LOTTERY_CONFIG')
  }
  const otherPrizes = config.prizes.filter(p => p.tier === 'prize' && p.reward.trim())
  if (config.prizes.filter(p => p.reward.trim()).length < 1) {
    throw new Error('INVALID_LOTTERY_CONFIG')
  }
  if (config.redeemExpiryMode === 'fixed' && !config.redeemFixedDate) {
    throw new Error('INVALID_LOTTERY_REDEEM')
  }
  if (config.redeemExpiryMode === 'relative' && (config.redeemRelativeAmount ?? 0) < 1) {
    throw new Error('INVALID_LOTTERY_REDEEM')
  }
}

export function parseLotteryConfig(configJson: string | null): LotteryConfig | null {
  if (!configJson) return null
  try {
    const parsed = JSON.parse(configJson) as { type?: string; lotteryConfig?: LotteryConfig }
    if (parsed.type !== 'lottery' || !parsed.lotteryConfig) return null
    return lotteryConfigSchema.parse(parsed.lotteryConfig)
  } catch {
    return null
  }
}

export function serializeLotteryConfig(config: LotteryConfig): string {
  return JSON.stringify({ type: 'lottery', lotteryConfig: config })
}
