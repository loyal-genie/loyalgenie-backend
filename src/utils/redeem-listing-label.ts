/**
 * Listing-only Redeem Before display (not wallet materialization).
 * Fixed → ISO calendar date; relative → "7 Days" / "1 Month" style period.
 */

export type RedeemRelativeUnit = 'day' | 'week' | 'month'

export type ListingRedeemConfig = {
  redeemExpiryMode?: 'fixed' | 'relative'
  redeemFixedDate?: string | null
  redeemRelativeAmount?: number | null
  redeemRelativeUnit?: RedeemRelativeUnit | null
}

export function formatRedeemRelativePeriodLabel(
  amount: number,
  unit: RedeemRelativeUnit,
): string {
  const base = unit === 'day' ? 'Day' : unit === 'week' ? 'Week' : 'Month'
  return `${amount} ${amount === 1 ? base : `${base}s`}`
}

export function formatListingRedeemBefore(config: ListingRedeemConfig): string | null {
  const mode = config.redeemExpiryMode ?? 'relative'
  if (mode === 'fixed') {
    const date = config.redeemFixedDate?.trim()
    return date || null
  }
  const amount = config.redeemRelativeAmount ?? 0
  const unit = config.redeemRelativeUnit
  if (!amount || amount < 1 || !unit) return null
  return formatRedeemRelativePeriodLabel(amount, unit)
}
