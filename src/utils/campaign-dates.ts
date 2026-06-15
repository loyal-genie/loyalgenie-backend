/** Business campaign calendar uses Asia/Kolkata per shake-and-win spec (v1). */
export const CAMPAIGN_TIMEZONE = 'Asia/Kolkata'

export function todayInCampaignTz(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CAMPAIGN_TIMEZONE }).format(date)
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

/** SQLite expression: UTC datetime column → calendar date in IST. */
export function istDateSql(column: string): string {
  return `date(${column}, '+5 hours', '+30 minutes')`
}
