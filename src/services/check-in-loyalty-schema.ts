import { z } from 'zod'

export const LOYALTY_POINTS_THRESHOLD_MAX = 99_999

export const loyaltyMilestoneSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(''),
  icon: z.string().min(1).default('🎁'),
  pointsThreshold: z.number().int().min(1).max(LOYALTY_POINTS_THRESHOLD_MAX),
})

export const checkInLoyaltyConfigSchema = z.object({
  pointsPerCheckIn: z.coerce.number().int().min(1).max(999),
})

export const createCheckInLoyaltyCampaignSchema = z.object({
  name: z.string().min(1),
  mechanic: z.literal('check-in-loyalty'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  userCap: z.number().int().min(1),
  checkInConfig: checkInLoyaltyConfigSchema,
  milestones: z.array(loyaltyMilestoneSchema).min(1),
})

export type CreateCheckInLoyaltyCampaignPayload = z.infer<typeof createCheckInLoyaltyCampaignSchema>
export type CheckInLoyaltyConfig = z.infer<typeof checkInLoyaltyConfigSchema>
export type LoyaltyMilestone = z.infer<typeof loyaltyMilestoneSchema>

export function validateMilestones(milestones: { pointsThreshold: number }[]): void {
  const thresholds = milestones.map(m => m.pointsThreshold).sort((a, b) => a - b)
  const unique = new Set(thresholds)
  if (unique.size !== thresholds.length) {
    throw new Error('INVALID_LOYALTY_MILESTONES')
  }
}
