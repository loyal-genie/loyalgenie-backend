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

export const spinSegmentSchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1),
  color: z.string().min(1),
  isWin: z.boolean(),
  probability: z.number().int().min(1).max(100),
  reward: z.string().nullable().optional().default(null),
  ...redeemFields,
})

export const spinConfigSchema = z.object({
  segments: z.array(spinSegmentSchema).min(2),
})

export type SpinConfig = z.infer<typeof spinConfigSchema>
export type SpinSegment = z.infer<typeof spinSegmentSchema>

export const createSpinCampaignSchema = z.object({
  name: z.string().min(1),
  mechanic: z.literal('spin'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: timeSchema.default('00:00'),
  endTime: timeSchema.default('23:59'),
  userCap: z.number().int().min(1),
  perDayUserLimit: z.number().int().min(1),
  playsPerDay: z.number().int().min(1).max(10),
  spinConfig: spinConfigSchema,
})

export type CreateSpinCampaignPayload = z.infer<typeof createSpinCampaignSchema>

export function spinSegmentProbabilityTotal(segments: SpinSegment[]): number {
  return segments.reduce((s, seg) => s + seg.probability, 0)
}

export function validateSpinConfig(config: SpinConfig): void {
  const winSegments = config.segments.filter(s => s.isWin && (s.reward ?? '').trim())
  if (winSegments.length < 1) {
    throw new Error('INVALID_SPIN_CONFIG')
  }
  if (spinSegmentProbabilityTotal(config.segments) !== 100) {
    throw new Error('SEGMENT_PROBABILITIES_MUST_SUM_100')
  }
  for (const seg of winSegments) {
    const mode = seg.redeemExpiryMode ?? 'relative'
    if (mode === 'fixed' && !seg.redeemFixedDate) {
      throw new Error('INVALID_SPIN_REDEEM')
    }
    if (mode === 'relative' && (seg.redeemRelativeAmount ?? 0) < 1) {
      throw new Error('INVALID_SPIN_REDEEM')
    }
  }
}

export function parseSpinConfig(configJson: string | null): SpinConfig | null {
  if (!configJson) return null
  try {
    const parsed = JSON.parse(configJson) as { type?: string; spinConfig?: SpinConfig }
    if (parsed.type !== 'spin' || !parsed.spinConfig) return null
    const raw = parsed.spinConfig
    const segments = raw.segments.map(seg => ({
      ...seg,
      probability: seg.probability ?? Math.floor(100 / raw.segments.length),
    }))
    const total = spinSegmentProbabilityTotal(segments)
    if (total !== 100 && segments.length > 0) {
      const last = segments.length - 1
      segments[last] = {
        ...segments[last]!,
        probability: (segments[last]?.probability ?? 0) + (100 - total),
      }
    }
    return spinConfigSchema.parse({ segments })
  } catch {
    return null
  }
}

/** Win rate = sum of winning segment probabilities (wheel slice %). */
export function spinWinRatePercent(segments: SpinSegment[]): number {
  return segments.filter(s => s.isWin).reduce((s, seg) => s + seg.probability, 0)
}

export function spinOverallWinners(userCap: number, segments: SpinSegment[]): number {
  const winRate = spinWinRatePercent(segments)
  return Math.max(1, Math.round(userCap * winRate / 100))
}

/** Reward share percents among winners, weighted by segment probability. */
export function spinRewardShares(winSegments: SpinSegment[]): number[] {
  if (winSegments.length < 1) return []
  const total = winSegments.reduce((s, seg) => s + seg.probability, 0)
  if (total === 0) return spinRewardSharesEqual(winSegments.length)
  const raw = winSegments.map(s => Math.round((s.probability / total) * 100))
  const sum = raw.reduce((a, b) => a + b, 0)
  if (sum !== 100) raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) + (100 - sum)
  return raw
}

function spinRewardSharesEqual(winCount: number): number[] {
  const base = Math.floor(100 / winCount)
  return Array.from({ length: winCount }, (_, i) =>
    i === winCount - 1 ? 100 - base * (winCount - 1) : base,
  )
}
