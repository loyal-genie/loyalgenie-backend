import { z } from 'zod'

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

const redeemFields = {
  redeemExpiryMode: z.enum(['fixed', 'relative']),
  redeemFixedDate: z.string().nullable().optional(),
  redeemRelativeAmount: z.number().int().optional(),
  redeemRelativeUnit: z.enum(['day', 'week', 'month']).optional(),
}

export const friendConfigSchema = z.object({
  minFriends: z.number().int().min(1).max(20).default(2),
  rewardKind: z.enum(['flat', 'percent', 'item']),
  rewardValue: z.string().min(1),
  ...redeemFields,
})

export type FriendConfig = z.infer<typeof friendConfigSchema>

export const createFriendCampaignSchema = z.object({
  name: z.string().min(1),
  mechanic: z.literal('friend'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: timeSchema.default('00:00'),
  endTime: timeSchema.default('23:59'),
  userCap: z.number().int().min(1).max(10_000).default(200),
  friendConfig: friendConfigSchema,
})

export type CreateFriendCampaignPayload = z.infer<typeof createFriendCampaignSchema>

export function formatFriendRewardLabel(config: FriendConfig): string {
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

export function formatFriendSentence(config: FriendConfig): string {
  const n = config.minFriends
  const v = config.rewardValue.trim()
  const reward =
    config.rewardKind === 'flat'
      ? `Get ₹${v || 0} Off`
      : config.rewardKind === 'percent'
        ? `Get ${v || 0}% Off`
        : `Get ${v || 'Free Item'}`
  return `Bring ${n} Friend${n !== 1 ? 's' : ''} → ${reward}`
}

export function formatFriendDescription(config: FriendConfig): string {
  return `Bring ${config.minFriends} friend${config.minFriends !== 1 ? 's' : ''} · ${formatFriendRewardLabel(config)}`
}

export function validateFriendConfig(config: FriendConfig): void {
  if (config.minFriends < 1) throw new Error('INVALID_FRIEND_CONFIG')
  if (!config.rewardValue.trim()) throw new Error('INVALID_FRIEND_CONFIG')
  if (config.rewardKind === 'percent') {
    const n = Number(config.rewardValue)
    if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error('INVALID_FRIEND_CONFIG')
  }
  if (config.redeemExpiryMode === 'fixed' && !config.redeemFixedDate) {
    throw new Error('INVALID_FRIEND_REDEEM')
  }
  if (config.redeemExpiryMode === 'relative' && (config.redeemRelativeAmount ?? 0) < 1) {
    throw new Error('INVALID_FRIEND_REDEEM')
  }
}

export function parseFriendConfig(configJson: string | null): FriendConfig | null {
  if (!configJson) return null
  try {
    const parsed = JSON.parse(configJson) as { type?: string; friendConfig?: FriendConfig }
    if (parsed.type !== 'friend' || !parsed.friendConfig) return null
    return friendConfigSchema.parse(parsed.friendConfig)
  } catch {
    return null
  }
}

export function serializeFriendConfig(config: FriendConfig): string {
  return JSON.stringify({ type: 'friend', friendConfig: config })
}
