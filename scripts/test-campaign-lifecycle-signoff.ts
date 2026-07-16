/**
 * Prod signoff harness — maps exactly to the intended customer lifecycle.
 * Run: npx tsx scripts/test-campaign-lifecycle-signoff.ts
 */
import {
  isCampaignInWindow,
  isPastCampaignEndMoment,
  isBeforeCampaignStart,
  campaignLiveOnMessage,
  outsideActiveHoursMessage,
} from '../src/utils/campaign-dates.js'

type State = {
  listVisible: boolean
  canPlay: boolean
  label: 'LIVE_ON' | 'ACTIVE_HOURS' | 'NORMAL' | 'REMOVED' | 'OTHER'
  rawLabel?: string
}

function ist(local: string): Date {
  return new Date(`${local}:00+05:30`)
}

function derive(
  startDate: string,
  endDate: string,
  startTime: string,
  endTime: string,
  now: Date,
): State {
  const pastEnd = isPastCampaignEndMoment(endDate, endTime, now)
  if (pastEnd) {
    return { listVisible: false, canPlay: false, label: 'REMOVED' }
  }

  const beforeStart = isBeforeCampaignStart(startDate, startTime, now)
  const inWindow = isCampaignInWindow(startDate, endDate, startTime, endTime, now)

  if (beforeStart) {
    return {
      listVisible: true,
      canPlay: false,
      label: 'LIVE_ON',
      rawLabel: campaignLiveOnMessage(startDate, startTime),
    }
  }

  if (inWindow) {
    return { listVisible: true, canPlay: true, label: 'NORMAL' }
  }

  // Mid-range (or start day after first open) outside Active Hours
  return {
    listVisible: true,
    canPlay: false,
    label: 'ACTIVE_HOURS',
    rawLabel: outsideActiveHoursMessage(startTime, endTime),
  }
}

type Case = {
  id: string
  name: string
  now: Date
  startDate: string
  endDate: string
  startTime: string
  endTime: string
  expectVisible: boolean
  expectPlay: boolean
  expectLabel: State['label']
  expectCopyIncludes?: string
}

const S = '2026-07-10'
const E = '2026-07-15'
const ST = '16:00'
const ET = '21:00'

const cases: Case[] = [
  // Row 1 — created with start tomorrow
  {
    id: 'R1a',
    name: 'Future start full-day → Live on day month, no play',
    now: ist('2026-07-15T12:00'),
    startDate: '2026-07-16',
    endDate: '2026-07-20',
    startTime: '00:00',
    endTime: '23:59',
    expectVisible: true,
    expectPlay: false,
    expectLabel: 'LIVE_ON',
    expectCopyIncludes: 'Live on 16 Jul',
  },
  {
    id: 'R1b',
    name: 'Future start timed → Live on day month · time, no play',
    now: ist('2026-07-15T12:00'),
    startDate: '2026-07-16',
    endDate: '2026-07-20',
    startTime: '16:00',
    endTime: '21:00',
    expectVisible: true,
    expectPlay: false,
    expectLabel: 'LIVE_ON',
    expectCopyIncludes: 'Live on 16 Jul',
  },
  {
    id: 'R1c',
    name: 'Start two days out still visible immediately',
    now: ist('2026-07-15T09:00'),
    startDate: '2026-07-17',
    endDate: '2026-07-25',
    startTime: '10:00',
    endTime: '18:00',
    expectVisible: true,
    expectPlay: false,
    expectLabel: 'LIVE_ON',
  },

  // Row 2 — start day before start time
  {
    id: 'R2a',
    name: 'Start day 15:59 before 16:00 → Live on',
    now: ist('2026-07-10T15:59'),
    startDate: S,
    endDate: E,
    startTime: ST,
    endTime: ET,
    expectVisible: true,
    expectPlay: false,
    expectLabel: 'LIVE_ON',
  },
  {
    id: 'R2b',
    name: 'Start day exact 16:00 → playable',
    now: ist('2026-07-10T16:00'),
    startDate: S,
    endDate: E,
    startTime: ST,
    endTime: ET,
    expectVisible: true,
    expectPlay: true,
    expectLabel: 'NORMAL',
  },

  // Row 3 — inside window
  {
    id: 'R3a',
    name: 'Mid-range inside Active Hours → playable',
    now: ist('2026-07-12T18:00'),
    startDate: S,
    endDate: E,
    startTime: ST,
    endTime: ET,
    expectVisible: true,
    expectPlay: true,
    expectLabel: 'NORMAL',
  },
  {
    id: 'R3b',
    name: 'Last day inside Active Hours → playable',
    now: ist('2026-07-15T20:00'),
    startDate: S,
    endDate: E,
    startTime: ST,
    endTime: ET,
    expectVisible: true,
    expectPlay: true,
    expectLabel: 'NORMAL',
  },
  {
    id: 'R3c',
    name: 'Full-day mid-range always playable',
    now: ist('2026-07-12T03:00'),
    startDate: S,
    endDate: E,
    startTime: '00:00',
    endTime: '23:59',
    expectVisible: true,
    expectPlay: true,
    expectLabel: 'NORMAL',
  },

  // Row 4 — mid-range after daily hours
  {
    id: 'R4a',
    name: 'Mid-range after end_time → card stays, Active Hours',
    now: ist('2026-07-12T21:30'),
    startDate: S,
    endDate: E,
    startTime: ST,
    endTime: ET,
    expectVisible: true,
    expectPlay: false,
    expectLabel: 'ACTIVE_HOURS',
    expectCopyIncludes: 'Active Hours',
  },
  {
    id: 'R4b',
    name: 'Mid-range before open hour → Active Hours (already started days ago)',
    now: ist('2026-07-12T10:00'),
    startDate: S,
    endDate: E,
    startTime: ST,
    endTime: ET,
    expectVisible: true,
    expectPlay: false,
    expectLabel: 'ACTIVE_HOURS',
  },
  {
    id: 'R4c',
    name: 'Inclusive daily end minute still playable (not AH)',
    now: ist('2026-07-12T21:00'),
    startDate: S,
    endDate: E,
    startTime: ST,
    endTime: ET,
    expectVisible: true,
    expectPlay: true,
    expectLabel: 'NORMAL',
  },

  // Row 5 — past end date+time
  {
    id: 'R5a',
    name: 'Last day one minute past end_time → removed',
    now: ist('2026-07-15T21:01'),
    startDate: S,
    endDate: E,
    startTime: ST,
    endTime: ET,
    expectVisible: false,
    expectPlay: false,
    expectLabel: 'REMOVED',
  },
  {
    id: 'R5b',
    name: 'Last day exact end_time inclusive → still live',
    now: ist('2026-07-15T21:00'),
    startDate: S,
    endDate: E,
    startTime: ST,
    endTime: ET,
    expectVisible: true,
    expectPlay: true,
    expectLabel: 'NORMAL',
  },
  {
    id: 'R5c',
    name: 'Day after end_date → removed',
    now: ist('2026-07-16T00:00'),
    startDate: S,
    endDate: E,
    startTime: ST,
    endTime: ET,
    expectVisible: false,
    expectPlay: false,
    expectLabel: 'REMOVED',
  },
  {
    id: 'R5d',
    name: 'Full-day ends next calendar day at 00:00',
    now: ist('2026-07-16T00:00'),
    startDate: S,
    endDate: E,
    startTime: '00:00',
    endTime: '23:59',
    expectVisible: false,
    expectPlay: false,
    expectLabel: 'REMOVED',
  },
  {
    id: 'R5e',
    name: 'Same-day campaign past end → removed',
    now: ist('2026-07-15T14:01'),
    startDate: '2026-07-15',
    endDate: '2026-07-15',
    startTime: '10:00',
    endTime: '14:00',
    expectVisible: false,
    expectPlay: false,
    expectLabel: 'REMOVED',
  },

  // Extra edges
  {
    id: 'X1',
    name: 'Normalize 9:00 end — after 09:01 removed on end day',
    now: ist('2026-07-15T09:01'),
    startDate: '2026-07-15',
    endDate: '2026-07-15',
    startTime: '8:00',
    endTime: '9:00',
    expectVisible: false,
    expectPlay: false,
    expectLabel: 'REMOVED',
  },
  {
    id: 'X2',
    name: 'Last day after hours is REMOVED not Active Hours',
    now: ist('2026-07-15T21:30'),
    startDate: S,
    endDate: E,
    startTime: ST,
    endTime: ET,
    expectVisible: false,
    expectPlay: false,
    expectLabel: 'REMOVED',
  },
]

const results: Array<{ id: string; name: string; ok: boolean; detail: string }> = []

for (const c of cases) {
  const got = derive(c.startDate, c.endDate, c.startTime, c.endTime, c.now)
  const parts: string[] = []
  if (got.listVisible !== c.expectVisible) parts.push(`visible=${got.listVisible} want ${c.expectVisible}`)
  if (got.canPlay !== c.expectPlay) parts.push(`play=${got.canPlay} want ${c.expectPlay}`)
  if (got.label !== c.expectLabel) parts.push(`label=${got.label} want ${c.expectLabel}`)
  if (c.expectCopyIncludes && got.rawLabel && !got.rawLabel.includes(c.expectCopyIncludes)) {
    parts.push(`copy missing "${c.expectCopyIncludes}" in "${got.rawLabel}"`)
  }
  results.push({
    id: c.id,
    name: c.name,
    ok: parts.length === 0,
    detail: parts.length === 0
      ? `visible=${got.listVisible} play=${got.canPlay} label=${got.label}${got.rawLabel ? ` [${got.rawLabel}]` : ''}`
      : parts.join('; '),
  })
}

const failed = results.filter(r => !r.ok)
console.log('\n=== Lifecycle signoff (intended behaviour matrix) ===\n')
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.id} ${r.name}`)
  console.log(`    ${r.detail}`)
}
console.log(`\nTOTAL ${results.filter(r => r.ok).length}/${results.length} passed`)
if (failed.length) {
  console.error('\nFAILURES:', failed.map(f => f.id).join(', '))
  process.exit(1)
}
console.log('\nSIGNOFF HARNESS PASSED\n')
console.log(JSON.stringify({
  summary: { passed: results.length, failed: 0 },
  results,
}))
