import { z } from 'zod'
import { addCampaignDays, addCampaignMonths, todayInCampaignTz } from './campaign-dates.js'

export const redeemExpiryModeSchema = z.enum(['fixed', 'relative'])
export const redeemRelativeUnitSchema = z.enum(['day', 'week', 'month'])

/**
 * Materialize a redeem-before deadline.
 * Fixed mode returns the configured calendar date.
 * Relative mode adds the period to `fromDate` (defaults to today in campaign TZ),
 * i.e. the win/claim date — not campaign start or creation time.
 */
export function computeRedeemExpiryDate(
  mode: 'fixed' | 'relative',
  fixedDate: string | null,
  relativeAmount: number | null,
  relativeUnit: 'day' | 'week' | 'month' | null,
  fromDate?: string,
): string | null {
  if (mode === 'fixed') return fixedDate
  if (!relativeAmount || !relativeUnit) return null
  const base = fromDate ?? todayInCampaignTz()
  if (relativeUnit === 'day') return addCampaignDays(base, relativeAmount)
  if (relativeUnit === 'week') return addCampaignDays(base, relativeAmount * 7)
  if (relativeUnit === 'month') return addCampaignMonths(base, relativeAmount)
  return null
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
