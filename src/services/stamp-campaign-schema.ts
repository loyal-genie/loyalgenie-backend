import { z } from 'zod'

const stampRewardEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(''),
  icon: z.string().min(1).default('🎁'),
  winPercent: z.number().int().min(1).max(100),
})

export const stampConfigSchema = z.object({
  totalStamps: z.number().int().min(5).max(20),
  prefillStamps: z.number().int().min(0),
  surpriseRange: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
  bigRange: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
  surpriseMode: z.enum(['single', 'pool']),
  bigMode: z.enum(['single', 'pool']),
})

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
    surprise: z.array(stampRewardEntrySchema).min(1),
    big: z.array(stampRewardEntrySchema).min(1),
  }),
})

export type CreateStampCampaignPayload = z.infer<typeof createStampCampaignSchema>
export type StampConfig = z.infer<typeof stampConfigSchema>
