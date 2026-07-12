/**
 * Regression: same-day lottery ("Today" / custom same date) must stay open
 * until endTime IST (default 23:59), not close after startTime.
 *
 * Run: npx tsx scripts/test-lottery-same-day-window.ts
 */
import { isLotteryCampaignActive, isLotteryDrawDue } from '../src/services/lottery-service.js'
import { setCampaignDateOverride } from '../src/utils/campaign-dates.js'

const today = '2026-07-10'
setCampaignDateOverride(today) // noon IST

let failed = 0
function assert(label: string, actual: boolean, expected: boolean) {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label} (got ${actual}, want ${expected})`)
}

assert(
  'Today 00:00–23:59 at noon IST → entries open',
  isLotteryCampaignActive('active', today, today, '00:00', '23:59', false),
  true,
)
assert(
  'Custom same-day 00:00–23:59 at noon IST → entries open',
  isLotteryCampaignActive('active', today, today, '00:00', '23:59', false),
  true,
)
assert(
  'Same-day before start (18:00) at noon → closed',
  isLotteryCampaignActive('active', today, today, '18:00', '23:59', false),
  false,
)
assert(
  'Multi-day mid window → open',
  isLotteryCampaignActive('active', '2026-07-01', '2026-07-20', '00:00', '23:59', false),
  true,
)
assert(
  'Draw not due at noon on end day before 23:59',
  isLotteryDrawDue(today, '23:59', false),
  false,
)
assert(
  'Draw completed → inactive',
  isLotteryCampaignActive('active', today, today, '00:00', '23:59', true),
  false,
)

setCampaignDateOverride(null)
process.exit(failed === 0 ? 0 : 1)
