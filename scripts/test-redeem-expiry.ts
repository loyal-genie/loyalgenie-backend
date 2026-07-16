/**
 * Validates redeem-before relative expiry is anchored to win/claim date (IST calendar).
 * Run: npx tsx scripts/test-redeem-expiry.ts
 */
import { setCampaignDateOverride } from '../src/utils/campaign-dates.js'
import {
  computeRedeemExpiryDate,
  isCustomerRewardExpired,
} from '../src/utils/redeem-expiry.js'

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error('FAIL:', message)
    process.exit(1)
  }
  console.log('OK:', message)
}

try {
  // Fixed date — independent of claim date
  assert(
    computeRedeemExpiryDate('fixed', '2026-12-25', null, null, '2026-07-10') === '2026-12-25',
    'fixed mode returns configured date',
  )

  // Relative: 1 day from claim date (user claims Jul 10 → expires Jul 11)
  assert(
    computeRedeemExpiryDate('relative', null, 1, 'day', '2026-07-10') === '2026-07-11',
    '1 day relative from claim date',
  )

  // Relative: 7 days from claim date
  assert(
    computeRedeemExpiryDate('relative', null, 7, 'day', '2026-07-10') === '2026-07-17',
    '7 days relative from claim date',
  )

  // Relative: 1 week from claim date
  assert(
    computeRedeemExpiryDate('relative', null, 1, 'week', '2026-07-10') === '2026-07-17',
    '1 week relative from claim date',
  )

  // Relative: 1 month from claim date
  assert(
    computeRedeemExpiryDate('relative', null, 1, 'month', '2026-07-10') === '2026-08-10',
    '1 month relative from claim date',
  )

  // Expiry check: valid through redeem-before date (inclusive)
  setCampaignDateOverride('2026-07-11')
  assert(
    !isCustomerRewardExpired('2026-07-11'),
    'reward valid on redeem-before date',
  )
  setCampaignDateOverride('2026-07-12')
  assert(
    isCustomerRewardExpired('2026-07-11'),
    'reward expired day after redeem-before date',
  )
  setCampaignDateOverride(null)

  console.log('\nAll redeem-before checks passed.')
} catch (err) {
  console.error(err)
  process.exit(1)
}
