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

/** Next midnight IST as ISO string (PIN rotation for stamp campaigns). */
export function nextMidnightIsoInCampaignTz(from = new Date()): string {
  const today = todayInCampaignTz(from)
  const tomorrow = addCampaignDays(today, 1)
  return new Date(`${tomorrow}T00:00:00+05:30`).toISOString()
}

export function isCampaignInDateWindow(
  startDate: string,
  endDate: string,
  today = todayInCampaignTz(),
): boolean {
  return today >= startDate && today <= endDate
}

export function isCampaignPastEnd(endDate: string, today = todayInCampaignTz()): boolean {
  return today > endDate
}

/** Calendar date of a UTC timestamp column in Asia/Kolkata (Postgres). */
export function istDateSql(column: string): string {
  return `((${column})::timestamptz AT TIME ZONE 'Asia/Kolkata')::date`
}
