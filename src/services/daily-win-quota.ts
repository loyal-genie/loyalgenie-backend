/**
 * Win quota — fixed overall winner cap (not percentage-based).
 *
 * - **overallWinners**: max unique winners across the whole campaign.
 * - Each customer wins at most once per day.
 * - Plays per user/day only limits attempts — never affects win odds.
 * - Daily user limit (enrollment) is separate — handled in checkEligibility.
 *
 * Winners are drawn randomly across the campaign until the overall cap is reached.
 * Among today's non-winners, each eligible play gets
 * `slotsRemaining / nonWinnersRemaining` chance to win.
 */

export interface DailyQuotaContext {
  uniquePlayersBefore: number
  isFirstPlayToday: boolean
  winsBeforeToday: number
  totalWinsBefore: number
  overallWinners: number
  customerAlreadyWonToday?: boolean
}

export interface DailyQuotaSnapshot {
  uniquePlayersAfter: number
  winsBeforeToday: number
  totalWinsBefore: number
  slotsRemaining: number
}

export function dailyQuotaSnapshot(ctx: DailyQuotaContext): DailyQuotaSnapshot {
  const uniquePlayersAfter = ctx.isFirstPlayToday
    ? ctx.uniquePlayersBefore + 1
    : ctx.uniquePlayersBefore

  return {
    uniquePlayersAfter,
    winsBeforeToday: ctx.winsBeforeToday,
    totalWinsBefore: ctx.totalWinsBefore,
    slotsRemaining: Math.max(0, ctx.overallWinners - ctx.totalWinsBefore),
  }
}

export function rollWinWithDailyQuota(
  ctx: DailyQuotaContext,
  rng: () => number = Math.random,
): boolean {
  if (ctx.customerAlreadyWonToday) return false

  const snap = dailyQuotaSnapshot(ctx)
  if (snap.slotsRemaining <= 0) return false

  const nonWinnersRemaining = Math.max(1, snap.uniquePlayersAfter - ctx.winsBeforeToday)
  return rng() < snap.slotsRemaining / nonWinnersRemaining
}

/** @deprecated Use cap-based fields in tests only. */
export function targetWinsForPlayers(uniquePlayers: number, winRatePercent: number): number {
  return Math.round((uniquePlayers * winRatePercent) / 100)
}

export function simulateDay(
  uniquePlayers: number,
  overallWinners: number,
  rng: () => number = Math.random,
): number {
  let winsToday = 0
  let totalWins = 0
  let unique = 0
  for (let i = 0; i < uniquePlayers; i++) {
    const won = rollWinWithDailyQuota(
      {
        uniquePlayersBefore: unique,
        isFirstPlayToday: true,
        winsBeforeToday: winsToday,
        totalWinsBefore: totalWins,
        overallWinners,
      },
      rng,
    )
    if (won) {
      winsToday++
      totalWins++
    }
    unique++
  }
  return winsToday
}
