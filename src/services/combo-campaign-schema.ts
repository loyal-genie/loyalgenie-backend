import { z } from 'zod'

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

const redeemFields = {
  redeemExpiryMode: z.enum(['fixed', 'relative']),
  redeemFixedDate: z.string().nullable().optional(),
  redeemRelativeAmount: z.number().int().optional(),
  redeemRelativeUnit: z.enum(['day', 'week', 'month']).optional(),
}

export const comboConfigSchema = z.object({
  variant: z.enum(['discount', 'freeitem']),
  items: z.array(z.string()).default([]),
  originalPrice: z.number().min(0).default(0),
  bundlePrice: z.number().min(0).default(0),
  paidItems: z.array(z.string()).default([]),
  freeItems: z.array(z.string()).default([]),
  totalSpots: z.number().int().min(1).max(10_000).default(100),
  termsAndConditions: z.string().default(''),
  ...redeemFields,
})

export type ComboConfig = z.infer<typeof comboConfigSchema>

export const createComboCampaignSchema = z.object({
  name: z.string().min(1),
  mechanic: z.literal('combo'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: timeSchema.default('00:00'),
  endTime: timeSchema.default('23:59'),
  comboConfig: comboConfigSchema,
})

export type CreateComboCampaignPayload = z.infer<typeof createComboCampaignSchema>

export function formatComboRewardLabel(config: ComboConfig): string {
  if (config.variant === 'freeitem') {
    const free = config.freeItems.map(i => i.trim()).filter(Boolean)
    return free.length ? `Get ${free.join(', ')} Free` : 'Combo Deal'
  }
  return `₹${config.bundlePrice || 0} Bundle`
}

export function formatComboSentence(config: ComboConfig): string {
  if (config.variant === 'freeitem') {
    const paid = config.paidItems.map(i => i.trim()).filter(Boolean)
    const free = config.freeItems.map(i => i.trim()).filter(Boolean)
    return `Take ${paid.join(', ') || '—'} → Get ${free.join(', ') || '—'} Free`
  }
  const itemCount = config.items.map(i => i.trim()).filter(Boolean).length
  return `${itemCount} Item${itemCount !== 1 ? 's' : ''} → ₹${config.bundlePrice || 0} (was ₹${config.originalPrice || 0})`
}

export function formatComboDescription(config: ComboConfig): string {
  const terms = config.termsAndConditions.trim()
  const sentence = formatComboSentence(config)
  return terms ? `${sentence} · ${terms}` : sentence
}

export function validateComboConfig(config: ComboConfig): void {
  if (config.totalSpots < 1) throw new Error('INVALID_COMBO_CONFIG')
  if (config.variant === 'discount') {
    const items = config.items.map(i => i.trim()).filter(Boolean)
    if (items.length < 1) throw new Error('INVALID_COMBO_CONFIG')
    if (config.originalPrice <= 0 || config.bundlePrice <= 0) throw new Error('INVALID_COMBO_CONFIG')
    if (config.bundlePrice > config.originalPrice) throw new Error('INVALID_COMBO_CONFIG')
  } else {
    const paid = config.paidItems.map(i => i.trim()).filter(Boolean)
    const free = config.freeItems.map(i => i.trim()).filter(Boolean)
    if (paid.length < 1 || free.length < 1) throw new Error('INVALID_COMBO_CONFIG')
  }
  if (config.redeemExpiryMode === 'fixed' && !config.redeemFixedDate) {
    throw new Error('INVALID_COMBO_REDEEM')
  }
  if (config.redeemExpiryMode === 'relative' && (config.redeemRelativeAmount ?? 0) < 1) {
    throw new Error('INVALID_COMBO_REDEEM')
  }
}

export function parseComboConfig(configJson: string | null): ComboConfig | null {
  if (!configJson) return null
  try {
    const parsed = JSON.parse(configJson) as { type?: string; comboConfig?: ComboConfig }
    if (parsed.type !== 'combo' || !parsed.comboConfig) return null
    return comboConfigSchema.parse(parsed.comboConfig)
  } catch {
    return null
  }
}

export function serializeComboConfig(config: ComboConfig): string {
  return JSON.stringify({ type: 'combo', comboConfig: config })
}
