import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/** Business campaign calendar uses Asia/Kolkata per shake-and-win spec (v1). */
export const CAMPAIGN_TIMEZONE = 'Asia/Kolkata'

/** Test-only override — set via setCampaignDateOverride() in integration scripts. */
let campaignDateOverride: string | null = null

const OVERRIDE_FILE = process.env.CAMPAIGN_DATE_OVERRIDE_FILE
  ?? join(process.cwd(), '.campaign-date-override')

/** Dev-only: read simulated date written by scripts/sim-stamp-10-days.ts */
function readDevDateFile(): string | null {
  if (process.env.NODE_ENV === 'production') return null
  try {
    if (!existsSync(OVERRIDE_FILE)) return null
    const raw = readFileSync(OVERRIDE_FILE, 'utf8').trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  } catch {
    /* no file */
  }
  return null
}

function effectiveDateOverride(): string | null {
  return campaignDateOverride ?? readDevDateFile()
}

export function getCampaignDateOverrideFile(): string {
  return OVERRIDE_FILE
}

export function setCampaignDateOverride(iso: string | null): void {
  campaignDateOverride = iso
}

/** Current instant in campaign TZ (noon on override day, or real clock). */
export function nowInCampaignTz(): Date {
  const override = effectiveDateOverride()
  if (override) {
    return new Date(`${override}T12:00:00+05:30`)
  }
  return new Date()
}

export function todayInCampaignTz(date = new Date()): string {
  const override = effectiveDateOverride()
  if (override) return override
  return new Intl.DateTimeFormat('en-CA', { timeZone: CAMPAIGN_TIMEZONE }).format(date)
}

export function addCampaignDays(from: string, days: number): string {
  const [y, mo, d] = from.split('-').map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d + days))
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

export function addCampaignMonths(from: string, months: number): string {
  const [y, mo, d] = from.split('-').map(Number)
  const dt = new Date(Date.UTC(y, mo - 1 + months, d))
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

/** Next midnight IST as ISO string (PIN rotation for stamp campaigns). */
export function nextMidnightIsoInCampaignTz(from = new Date()): string {
  const today = todayInCampaignTz(from)
  const tomorrow = addCampaignDays(today, 1)
  return new Date(`${tomorrow}T00:00:00+05:30`).toISOString()
}

export function currentTimeInCampaignTz(date = nowInCampaignTz()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CAMPAIGN_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const hour = parts.find(p => p.type === 'hour')?.value ?? '00'
  const minute = parts.find(p => p.type === 'minute')?.value ?? '00'
  return `${hour}:${minute}`
}

export function isCampaignInDateWindow(
  startDate: string,
  endDate: string,
  today = todayInCampaignTz(),
): boolean {
  return today >= startDate && today <= endDate
}

/** Normalize to HH:MM for lexicographic compare (handles "9:00" and "09:00:00"). */
export function normalizeHhMm(time: string): string {
  const raw = time.trim()
  const match = /^(\d{1,2}):(\d{2})/.exec(raw)
  if (!match) return raw.slice(0, 5)
  const h = Math.min(23, Math.max(0, Number(match[1])))
  const m = Math.min(59, Math.max(0, Number(match[2])))
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function isFullDayWindow(startTime: string, endTime: string): boolean {
  const start = normalizeHhMm(startTime)
  const end = normalizeHhMm(endTime)
  return (start === '00:00' || start === '0:00') && (end === '23:59' || end === '24:00')
}

/** e.g. "4:00 PM" from "16:00" */
export function formatClockAmPm(hhmm: string): string {
  const [hRaw, mRaw] = normalizeHhMm(hhmm).split(':').map(Number)
  const h24 = Number.isFinite(hRaw) ? hRaw : 0
  const m = Number.isFinite(mRaw) ? mRaw : 0
  const suffix = h24 >= 12 ? 'PM' : 'AM'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`
}

/** e.g. "16 Jul" from YYYY-MM-DD (customer Live on copy). */
export function formatDayMonthShort(isoDate: string): string {
  const day = isoDate.slice(0, 10)
  const [y, mo, d] = day.split('-').map(Number)
  if (!y || !mo || !d) return isoDate
  return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
}

/** @deprecated Prefer formatDayMonthShort for customer-facing copy. */
export function formatDdMm(isoDate: string): string {
  return formatDayMonthShort(isoDate)
}

/** Listing / eligibility copy when campaign has not started yet. */
export function campaignLiveOnMessage(startDate: string, startTime = '00:00'): string {
  const start = normalizeHhMm(startTime)
  const dateLabel = formatDayMonthShort(startDate)
  if (isFullDayWindow(start, '23:59') || start === '00:00') {
    return `Live on ${dateLabel}`
  }
  return `Live on ${dateLabel} · ${formatClockAmPm(start)}`
}

/** Customer-facing copy when outside the daily Active Hours window. */
export function outsideActiveHoursMessage(startTime = '00:00', endTime = '23:59'): string {
  const start = normalizeHhMm(startTime)
  const end = normalizeHhMm(endTime)
  if (isFullDayWindow(start, end)) return 'Campaign is not running today'
  return `Today · Active Hours ${formatClockAmPm(start)}–${formatClockAmPm(end)}`
}

/**
 * True when the campaign has not opened yet (future start calendar day,
 * or start day before start_time). Mid-range outside Active Hours is false.
 */
export function isBeforeCampaignStart(
  startDate: string,
  startTime = '00:00',
  now = nowInCampaignTz(),
): boolean {
  const today = todayInCampaignTz(now)
  if (today < startDate) return true
  if (today > startDate) return false
  const start = normalizeHhMm(startTime)
  if (start === '00:00') return false
  return currentTimeInCampaignTz(now) < start
}

/** Date + optional IST time window (HH:MM). Defaults: 00:00 start, 23:59 end. */
export function isCampaignInWindow(
  startDate: string,
  endDate: string,
  startTime = '00:00',
  endTime = '23:59',
  now = nowInCampaignTz(),
): boolean {
  const today = todayInCampaignTz(now)
  if (today < startDate || today > endDate) return false
  const time = currentTimeInCampaignTz(now)
  const start = normalizeHhMm(startTime)
  const end = normalizeHhMm(endTime)
  // Active Hours / daily window: when not full-day, enforce every day in range.
  // Full-day (00:00–23:59) keeps first/last-day gating for continuous custom ranges stored as 00:00/23:59.
  const isFullDay = (start === '00:00' || start === '0:00') && (end === '23:59' || end === '24:00')
  if (!isFullDay) {
    if (time < start || time > end) return false
    return true
  }
  if (today === startDate && time < start) return false
  if (today === endDate && time > end) return false
  return true
}

export function isCampaignPastEnd(endDate: string, today = todayInCampaignTz()): boolean {
  return today > endDate
}

/**
 * True when the campaign schedule is over:
 * - calendar day after end_date, OR
 * - on end_date after end_time (normalized HH:MM).
 * Full-day end (23:59) typically removes the next calendar day, not at 23:59:01.
 */
export function isPastCampaignEndMoment(
  endDate: string,
  endTime = '23:59',
  now = nowInCampaignTz(),
): boolean {
  const today = todayInCampaignTz(now)
  if (today > endDate) return true
  if (today < endDate) return false
  const time = currentTimeInCampaignTz(now)
  return time > normalizeHhMm(endTime)
}

/** Calendar date of a UTC timestamp column in Asia/Kolkata (Postgres). */
export function istDateSql(column: string): string {
  return `((${column})::timestamptz AT TIME ZONE 'Asia/Kolkata')::date`
}
