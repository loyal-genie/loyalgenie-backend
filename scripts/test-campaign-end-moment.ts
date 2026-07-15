/**
 * Deep edge-case harness for campaign end_date + end_time removal vs Active Hours.
 * Run: npx tsx scripts/test-campaign-end-moment.ts
 */
import {
  isCampaignInWindow,
  isPastCampaignEndMoment,
  campaignLiveOnMessage,
  outsideActiveHoursMessage,
  addCampaignDays,
} from '../src/utils/campaign-dates.js'
import {
  isStampCampaignActive,
  getClaimDeadline,
} from '../src/services/stamp-cards.js'
import { isLotteryCampaignActive } from '../src/services/lottery-service.js'

type Verdict = 'PASS' | 'FAIL'
type CaseResult = {
  id: string
  group: string
  name: string
  expected: string
  actual: string
  verdict: Verdict
  detail?: string
}

const results: CaseResult[] = []

function ist(isoLocal: string): Date {
  // isoLocal like '2026-07-15T21:00' → IST instant
  return new Date(`${isoLocal}:00+05:30`)
}

function assertCase(
  group: string,
  id: string,
  name: string,
  expected: string,
  actual: string,
  detail?: string,
) {
  results.push({
    id,
    group,
    name,
    expected,
    actual,
    verdict: expected === actual ? 'PASS' : 'FAIL',
    detail,
  })
}

/** Mirrors customer list visibility for non-stamp mechanics. */
function listVisibleStandard(endDate: string, endTime: string, now: Date): boolean {
  return !isPastCampaignEndMoment(endDate, endTime, now)
}

/** Mirrors play gate (isCampaignInWindow). */
function canPlayWindow(
  startDate: string,
  endDate: string,
  startTime: string,
  endTime: string,
  now: Date,
): boolean {
  return isCampaignInWindow(startDate, endDate, startTime, endTime, now)
}

/** Mirrors eligibility messaging branches (sans status). */
function eligibilityCopy(
  startDate: string,
  endDate: string,
  startTime: string,
  endTime: string,
  now: Date,
): string {
  if (canPlayWindow(startDate, endDate, startTime, endTime, now)) return 'CAN_PLAY'
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now)
  if (today < startDate) return campaignLiveOnMessage(startDate, startTime)
  return outsideActiveHoursMessage(startTime, endTime)
}

/** After ensure/autoEnd, status would become ended? */
function wouldAutoEnd(endDate: string, endTime: string, now: Date, mechanic = 'shake'): boolean {
  if (mechanic === 'stamp') return false // stamp uses claim deadline, not end_time batch
  return isPastCampaignEndMoment(endDate, endTime, now)
}

function combinedState(
  startDate: string,
  endDate: string,
  startTime: string,
  endTime: string,
  now: Date,
): string {
  const visible = listVisibleStandard(endDate, endTime, now)
  const play = canPlayWindow(startDate, endDate, startTime, endTime, now)
  const ended = wouldAutoEnd(endDate, endTime, now)
  if (!visible && ended) return 'REMOVED'
  if (visible && play) return 'LIVE_PLAYABLE'
  if (visible && !play) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now)
    if (today < startDate) return 'UPCOMING_VISIBLE'
    return 'VISIBLE_OUTSIDE_HOURS'
  }
  return `UNEXPECTED(visible=${visible},play=${play},ended=${ended})`
}

// ─── A. Core last-day end_time removal ───────────────────────────────────────
{
  const g = 'A. Last-day end_time'
  const start = '2026-07-10'
  const end = '2026-07-15'
  const st = '16:00'
  const et = '21:00'

  assertCase(g, 'A1', 'day before end, after hours', 'VISIBLE_OUTSIDE_HOURS',
    combinedState(start, end, st, et, ist('2026-07-14T22:00')))
  assertCase(g, 'A2', 'end day before start hour', 'VISIBLE_OUTSIDE_HOURS',
    combinedState(start, end, st, et, ist('2026-07-15T15:00')))
  assertCase(g, 'A3', 'end day at exact end_time (inclusive)', 'LIVE_PLAYABLE',
    combinedState(start, end, st, et, ist('2026-07-15T21:00')))
  assertCase(g, 'A4', 'end day one minute after end_time', 'REMOVED',
    combinedState(start, end, st, et, ist('2026-07-15T21:01')))
  assertCase(g, 'A5', 'end day mid Active Hours', 'LIVE_PLAYABLE',
    combinedState(start, end, st, et, ist('2026-07-15T18:30')))
  assertCase(g, 'A6', 'day after end_date', 'REMOVED',
    combinedState(start, end, st, et, ist('2026-07-16T00:01')))
  assertCase(g, 'A7', 'mid-range during Active Hours', 'LIVE_PLAYABLE',
    combinedState(start, end, st, et, ist('2026-07-12T17:00')))
}

// ─── B. Full-day 00:00–23:59 ─────────────────────────────────────────────────
{
  const g = 'B. Full-day window'
  const start = '2026-07-10'
  const end = '2026-07-15'
  assertCase(g, 'B1', 'end day 23:58 still playable', 'LIVE_PLAYABLE',
    combinedState(start, end, '00:00', '23:59', ist('2026-07-15T23:58')))
  assertCase(g, 'B2', 'exactly 23:59 inclusive (not removed until next day)', 'LIVE_PLAYABLE',
    combinedState(start, end, '00:00', '23:59', ist('2026-07-15T23:59')))
  assertCase(g, 'B3', 'next day 00:00 removed', 'REMOVED',
    combinedState(start, end, '00:00', '23:59', ist('2026-07-16T00:00')))
  assertCase(g, 'B4', 'past calendar end_date removed', 'REMOVED',
    combinedState(start, end, '00:00', '23:59', ist('2026-07-17T12:00')))
}

// ─── C. Time normalization ───────────────────────────────────────────────────
{
  const g = 'C. HH:MM normalize'
  const end = '2026-07-15'
  assertCase(g, 'C1', '"9:00" vs after 09:01', 'true',
    String(isPastCampaignEndMoment(end, '9:00', ist('2026-07-15T09:01'))))
  assertCase(g, 'C2', '"09:00" vs before 08:59', 'false',
    String(isPastCampaignEndMoment(end, '09:00', ist('2026-07-15T08:59'))))
  assertCase(g, 'C3', '"09:00:00" with seconds suffix', 'true',
    String(isPastCampaignEndMoment(end, '09:00:00', ist('2026-07-15T09:01'))))
  assertCase(g, 'C4', 'single-digit hour in window', 'LIVE_PLAYABLE',
    combinedState('2026-07-15', end, '9:00', '10:00', ist('2026-07-15T09:30')))
}

// ─── D. Upcoming vs ended ────────────────────────────────────────────────────
{
  const g = 'D. Upcoming + ended'
  assertCase(g, 'D1', 'before start date shows upcoming', 'UPCOMING_VISIBLE',
    combinedState('2026-07-20', '2026-07-25', '16:00', '21:00', ist('2026-07-15T12:00')))
  assertCase(g, 'D2', 'start day before start_time', 'VISIBLE_OUTSIDE_HOURS',
    combinedState('2026-07-15', '2026-07-20', '16:00', '21:00', ist('2026-07-15T15:00')))
  assertCase(g, 'D3', 'start day at start_time playable', 'LIVE_PLAYABLE',
    combinedState('2026-07-15', '2026-07-20', '16:00', '21:00', ist('2026-07-15T16:00')))
  assertCase(g, 'D4', 'same-day campaign after end', 'REMOVED',
    combinedState('2026-07-15', '2026-07-15', '10:00', '14:00', ist('2026-07-15T14:01')))
  assertCase(g, 'D5', 'same-day during hours', 'LIVE_PLAYABLE',
    combinedState('2026-07-15', '2026-07-15', '10:00', '14:00', ist('2026-07-15T12:00')))
}

// ─── E. Active Hours ≠ remove ────────────────────────────────────────────────
{
  const g = 'E. Active Hours mid-range'
  const start = '2026-07-01'
  const end = '2026-07-31'
  const st = '16:00'
  const et = '21:00'
  assertCase(g, 'E1', 'mid-range after AH: card stays', 'VISIBLE_OUTSIDE_HOURS',
    combinedState(start, end, st, et, ist('2026-07-15T21:30')))
  assertCase(g, 'E2', 'mid-range after AH: listVisible true', 'true',
    String(listVisibleStandard(end, et, ist('2026-07-15T21:30'))))
  assertCase(g, 'E3', 'mid-range after AH: canPlay false', 'false',
    String(canPlayWindow(start, end, st, et, ist('2026-07-15T21:30'))))
  assertCase(g, 'E4', 'eligibility copy is Active Hours', 'Today · Active Hours 4:00 PM–9:00 PM',
    eligibilityCopy(start, end, st, et, ist('2026-07-15T21:30')))
  assertCase(g, 'E5', 'last day after AH: REMOVED not Active Hours card', 'REMOVED',
    combinedState(start, end, st, et, ist('2026-07-31T21:30')))
}

// ─── F. Stamp claim window exception ─────────────────────────────────────────
{
  const g = 'F. Stamp exception'
  const start = '2026-07-01'
  const end = '2026-07-15'
  const claimDays = 30
  const deadline = getClaimDeadline(end, claimDays, null)
  const midClaim = addCampaignDays(end, 10)
  const afterClaim = addCampaignDays(deadline, 1)

  assertCase(g, 'F1', 'stamp still active after enrollment end (claim)', 'true',
    String(isStampCampaignActive('active', start, end, claimDays, null, midClaim)))
  assertCase(g, 'F2', 'stamp inactive after claim deadline', 'false',
    String(isStampCampaignActive('active', start, end, claimDays, null, afterClaim)))
  assertCase(g, 'F3', 'wouldAutoEnd(stamp) false on end day past end_time', 'false',
    String(wouldAutoEnd(end, '21:00', ist('2026-07-15T21:30'), 'stamp')))
  assertCase(g, 'F4', 'non-stamp wouldAutoEnd true same moment', 'true',
    String(wouldAutoEnd(end, '21:00', ist('2026-07-15T21:30'), 'shake')))
  assertCase(g, 'F5', 'stamp enrollment open ends calendar end_date', 'false',
    String(isStampCampaignActive('active', start, end, 0, null, addCampaignDays(end, 1))))
}

// ─── G. Lottery window + draw timing ─────────────────────────────────────────
{
  const g = 'G. Lottery'
  assertCase(g, 'G1', 'lottery window mid hours (pinned clock)', 'true',
    String(isCampaignInWindow('2026-07-10', '2026-07-15', '16:00', '21:00', ist('2026-07-12T18:00'))))
  assertCase(g, 'G2', 'lottery in window last day before end', 'true',
    String(isCampaignInWindow('2026-07-10', '2026-07-15', '16:00', '21:00', ist('2026-07-15T20:59'))))
  assertCase(g, 'G3', 'lottery past end_time last day', 'false',
    String(isCampaignInWindow('2026-07-10', '2026-07-15', '16:00', '21:00', ist('2026-07-15T21:01'))))
  assertCase(g, 'G4', 'drawCompleted → inactive', 'false',
    String(isLotteryCampaignActive('active', '2026-07-10', '2026-07-20', '00:00', '23:59', true)))
  assertCase(g, 'G5', 'status ended → inactive', 'false',
    String(isLotteryCampaignActive('ended', '2026-07-10', '2026-07-20', '00:00', '23:59', false)))
}

// ─── H. Deep-link / status flip semantics ────────────────────────────────────
{
  const g = 'H. Deep-link after end'
  const cases = [
    { id: 'H1', when: ist('2026-07-15T21:01'), expectGone: true },
    { id: 'H2', when: ist('2026-07-15T20:59'), expectGone: false },
    { id: 'H3', when: ist('2026-07-16T10:00'), expectGone: true },
  ]
  for (const c of cases) {
    const past = isPastCampaignEndMoment('2026-07-15', '21:00', c.when)
    assertCase(g, c.id, `ensure would end at ${c.when.toISOString()}`,
      String(c.expectGone), String(past))
  }
}

// ─── I. Boundary seconds (minute precision) ──────────────────────────────────
{
  const g = 'I. Minute precision'
  // currentTimeInCampaignTz truncates to HH:MM — 21:00:59 → "21:00"
  assertCase(g, 'I1', '21:00:59 still not past end 21:00', 'false',
    String(isPastCampaignEndMoment('2026-07-15', '21:00', new Date('2026-07-15T21:00:59+05:30'))))
  assertCase(g, 'I2', '21:01:00 is past', 'true',
    String(isPastCampaignEndMoment('2026-07-15', '21:00', new Date('2026-07-15T21:01:00+05:30'))))
}

// ─── J. List vs play matrix summary generators ───────────────────────────────
{
  const g = 'J. Matrix consistency'
  const schedule = { start: '2026-07-10', end: '2026-07-15', st: '16:00', et: '21:00' }
  const matrix: Array<[string, string, string]> = [
    ['2026-07-09T12:00', 'UPCOMING_VISIBLE', 'before start'],
    ['2026-07-10T15:59', 'VISIBLE_OUTSIDE_HOURS', 'start day before AH'],
    ['2026-07-10T16:00', 'LIVE_PLAYABLE', 'start day at open'],
    ['2026-07-12T21:00', 'LIVE_PLAYABLE', 'mid inclusive end hour'],
    ['2026-07-12T21:01', 'VISIBLE_OUTSIDE_HOURS', 'mid after AH keep card'],
    ['2026-07-15T21:00', 'LIVE_PLAYABLE', 'last minute inclusive'],
    ['2026-07-15T21:01', 'REMOVED', 'last day past end'],
    ['2026-07-16T00:00', 'REMOVED', 'next day'],
  ]
  matrix.forEach(([t, exp, label], i) => {
    assertCase(g, `J${i + 1}`, label, exp,
      combinedState(schedule.start, schedule.end, schedule.st, schedule.et, ist(t)))
  })
}

// ─── Report ──────────────────────────────────────────────────────────────────
const failed = results.filter(r => r.verdict === 'FAIL')
const passed = results.filter(r => r.verdict === 'PASS')

const byGroup = new Map<string, CaseResult[]>()
for (const r of results) {
  const list = byGroup.get(r.group) ?? []
  list.push(r)
  byGroup.set(r.group, list)
}

console.log('\n=== Campaign end_date + end_time deep test ===\n')
for (const [group, cases] of byGroup) {
  const ok = cases.filter(c => c.verdict === 'PASS').length
  console.log(`\n${group}  (${ok}/${cases.length})`)
  for (const c of cases) {
    const mark = c.verdict === 'PASS' ? '✓' : '✗'
    console.log(`  ${mark} ${c.id} ${c.name}`)
    console.log(`      expected=${c.expected}  actual=${c.actual}`)
    if (c.detail) console.log(`      note: ${c.detail}`)
  }
}

console.log(`\n──────────────`)
console.log(`TOTAL  ${passed.length} passed / ${failed.length} failed / ${results.length} cases`)

if (failed.length > 0) {
  console.error('\nFAILURES:')
  for (const f of failed) {
    console.error(`  ${f.id}: expected ${f.expected}, got ${f.actual}`)
  }
  process.exit(1)
}

console.log('\nALL EDGE CASES PASSED\n')

// Machine-readable summary for canvas ingest
console.log(JSON.stringify({
  summary: { passed: passed.length, failed: failed.length, total: results.length },
  results,
}, null, 0))
