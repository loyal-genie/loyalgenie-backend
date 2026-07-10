import { z } from 'zod'

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

const redeemFields = {
  redeemExpiryMode: z.enum(['fixed', 'relative']),
  redeemFixedDate: z.string().nullable().optional(),
  redeemRelativeAmount: z.number().int().optional(),
  redeemRelativeUnit: z.enum(['day', 'week', 'month']).optional(),
}

export const groupUnlockConfigSchema = z.object({
  targetParticipants: z.number().int().min(1).max(2_000).default(20),
  rewardKind: z.enum(['flat', 'percent', 'item']),
  rewardValue: z.string().min(1),
  ...redeemFields,
})

export type GroupUnlockConfig = z.infer<typeof groupUnlockConfigSchema>

export const createGroupUnlockCampaignSchema = z.object({
  name: z.string().min(1),
  mechanic: z.literal('groupunlock'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: timeSchema.default('00:00'),
  endTime: timeSchema.default('23:59'),
  groupUnlockConfig: groupUnlockConfigSchema,
})

export type CreateGroupUnlockCampaignPayload = z.infer<typeof createGroupUnlockCampaignSchema>

export function formatGroupUnlockRewardLabel(config: GroupUnlockConfig): string {
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

export function formatGroupUnlockSentence(config: GroupUnlockConfig): string {
  const n = config.targetParticipants
  const v = config.rewardValue.trim()
  const reward =
    config.rewardKind === 'flat'
      ? `Get ₹${v || 0} Off`
      : config.rewardKind === 'percent'
        ? `Get ${v || 0}% Off`
        : `Get ${v || 'Free Item'}`
  return `${n} People → ${reward}`
}

export function formatGroupUnlockDescription(config: GroupUnlockConfig): string {
  return `Community offer · ${config.targetParticipants} people · ${formatGroupUnlockRewardLabel(config)}`
}

export function validateGroupUnlockConfig(config: GroupUnlockConfig): void {
  if (config.targetParticipants < 1) throw new Error('INVALID_GROUPUNLOCK_CONFIG')
  if (!config.rewardValue.trim()) throw new Error('INVALID_GROUPUNLOCK_CONFIG')
  if (config.rewardKind === 'percent') {
    const n = Number(config.rewardValue)
    if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error('INVALID_GROUPUNLOCK_CONFIG')
  }
  if (config.redeemExpiryMode === 'fixed' && !config.redeemFixedDate) {
    throw new Error('INVALID_GROUPUNLOCK_REDEEM')
  }
  if (config.redeemExpiryMode === 'relative' && (config.redeemRelativeAmount ?? 0) < 1) {
    throw new Error('INVALID_GROUPUNLOCK_REDEEM')
  }
}

export function parseGroupUnlockConfig(configJson: string | null): GroupUnlockConfig | null {
  if (!configJson) return null
  try {
    const parsed = JSON.parse(configJson) as { type?: string; groupUnlockConfig?: GroupUnlockConfig }
    if (parsed.type !== 'groupunlock' || !parsed.groupUnlockConfig) return null
    return groupUnlockConfigSchema.parse(parsed.groupUnlockConfig)
  } catch {
    return null
  }
}

export function serializeGroupUnlockConfig(config: GroupUnlockConfig): string {
  return JSON.stringify({ type: 'groupunlock', groupUnlockConfig: config })
}
