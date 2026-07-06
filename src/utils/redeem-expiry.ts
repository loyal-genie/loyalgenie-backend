import { z } from 'zod'
import { nowInCampaignTz, todayInCampaignTz } from './campaign-dates.js'

export const redeemExpiryModeSchema = z.enum(['fixed', 'relative'])
export const redeemRelativeUnitSchema = z.enum(['day', 'week', 'month'])

export function computeRedeemExpiryDate(
  mode: 'fixed' | 'relative',
  fixedDate: string | null,
  relativeAmount: number | null,
  relativeUnit: 'day' | 'week' | 'month' | null,
): string | null {
  if (mode === 'fixed') return fixedDate
  if (!relativeAmount || !relativeUnit) return null
  const now = nowInCampaignTz()
  if (relativeUnit === 'day') now.setDate(now.getDate() + relativeAmount)
  if (relativeUnit === 'week') now.setDate(now.getDate() + (relativeAmount * 7))
  if (relativeUnit === 'month') now.setMonth(now.getMonth() + relativeAmount)
  return now.toISOString().slice(0, 10)
}

export function validateRedeemExpiryConfig(
  mode: 'fixed' | 'relative',
  fixedDate?: string | null,
  relativeAmount?: number | null,
  relativeUnit?: string | null,
): void {
  if (mode === 'fixed' && !fixedDate) {
    throw new Error('REDEEM_BEFORE_REQUIRED')
  }
  if (mode === 'relative') {
    if (!relativeAmount || relativeAmount < 1) throw new Error('REDEEM_BEFORE_REQUIRED')
    if (!relativeUnit) throw new Error('REDEEM_BEFORE_REQUIRED')
  }
}

export function isCustomerRewardExpired(redeemExpiresAt: string | null | undefined): boolean {
  if (!redeemExpiresAt) return false
  return todayInCampaignTz() > redeemExpiresAt.slice(0, 10)
}
