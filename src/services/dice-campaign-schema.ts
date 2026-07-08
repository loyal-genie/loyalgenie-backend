import { z } from 'zod'

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

const redeemFields = {
  description: z.string().optional().default(''),
  icon: z.string().optional().default('🎁'),
  redeemExpiryMode: z.enum(['fixed', 'relative']).optional(),
  redeemFixedDate: z.string().nullable().optional(),
  redeemRelativeAmount: z.number().int().optional(),
  redeemRelativeUnit: z.enum(['day', 'week', 'month']).optional(),
}

export const diceOutcomeSchema = z.object({
  id: z.string().optional(),
  value: z.number().int().min(1).max(6),
  isWin: z.boolean(),
  reward: z.string().nullable().optional().default(null),
  ...redeemFields,
})

export const diceConfigSchema = z.object({
  outcomes: z.array(diceOutcomeSchema).length(6),
})

export type DiceConfig = z.infer<typeof diceConfigSchema>
export type DiceOutcome = z.infer<typeof diceOutcomeSchema>

export const createDiceCampaignSchema = z.object({
  name: z.string().min(1),
  mechanic: z.literal('dice'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: timeSchema.default('00:00'),
  endTime: timeSchema.default('23:59'),
  userCap: z.number().int().min(1),
  perDayUserLimit: z.number().int().min(1),
  playsPerDay: z.number().int().min(1).max(10),
  diceConfig: diceConfigSchema,
})

export type CreateDiceCampaignPayload = z.infer<typeof createDiceCampaignSchema>

const DICE_FACE_COUNT = 6

export function validateDiceConfig(config: DiceConfig): void {
  const winOutcomes = config.outcomes.filter(o => o.isWin && (o.reward ?? '').trim())
  if (winOutcomes.length < 1) {
    throw new Error('INVALID_DICE_CONFIG')
  }
  if (config.outcomes.length !== DICE_FACE_COUNT) {
    throw new Error('INVALID_DICE_CONFIG')
  }
  const values = new Set(config.outcomes.map(o => o.value))
  if (values.size !== DICE_FACE_COUNT) {
    throw new Error('INVALID_DICE_CONFIG')
  }
  for (const outcome of winOutcomes) {
    const mode = outcome.redeemExpiryMode ?? 'relative'
    if (mode === 'fixed' && !outcome.redeemFixedDate) {
      throw new Error('INVALID_DICE_REDEEM')
    }
    if (mode === 'relative' && (outcome.redeemRelativeAmount ?? 0) < 1) {
      throw new Error('INVALID_DICE_REDEEM')
    }
  }
}

export function parseDiceConfig(configJson: string | null): DiceConfig | null {
  if (!configJson) return null
  try {
    const parsed = JSON.parse(configJson) as { type?: string; diceConfig?: DiceConfig }
    if (parsed.type !== 'dice' || !parsed.diceConfig) return null
    return diceConfigSchema.parse(parsed.diceConfig)
  } catch {
    return null
  }
}

/** Win rate = winning faces / 6 (each face is equally likely). */
export function diceWinRatePercent(outcomes: DiceOutcome[]): number {
  const winFaces = outcomes.filter(o => o.isWin && (o.reward ?? '').trim()).length
  return Math.round((winFaces / DICE_FACE_COUNT) * 100)
}

export function diceOverallWinners(userCap: number, outcomes: DiceOutcome[]): number {
  const winRate = diceWinRatePercent(outcomes)
  return Math.max(1, Math.round((userCap * winRate) / 100))
}

/** Reward share percents among winning faces (each face equally likely). */
export function diceRewardShares(winOutcomes: DiceOutcome[]): number[] {
  const count = winOutcomes.length
  if (count < 1) return []
  const base = Math.floor(100 / count)
  return Array.from({ length: count }, (_, i) =>
    i === count - 1 ? 100 - base * (count - 1) : base,
  )
}
