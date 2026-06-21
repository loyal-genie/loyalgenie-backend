/**
 * Daily win quota — player-based (not play-based).
 *
 * ## Definitions
 * - **Player** = unique customer who plays today.
 * - **Daily target** = `round(N × winRate%)` **unique players** who win when N players have played.
 *   Example: 25 players × 100% → **25 winners**. 50 players × 5% → **3 winners**.
 *
 * ## Who wins?
 * - Each customer can win **at most once per day**.
 * - `winsBefore` counts **distinct winning players**, not total winning plays.
 * - First play today: gap-based lottery among new players entering the pool.
 * - Repeat play (same day, no win yet): lottery for remaining winner slots among non-winners.
 *
 * Plays per user/day only controls how many attempts a customer gets — it does not inflate the winner count.
 */

export interface DailyQuotaContext {
  uniquePlayersBefore: number
  isFirstPlayToday: boolean
  winsBefore: number
  winRatePercent: number
  /** Kept for API compatibility. */
  perDayUserLimit: number
  customerAlreadyWonToday?: boolean
}

export interface DailyQuotaSnapshot {
  uniquePlayersAfter: number
  targetWins: number
  targetBefore: number
  winsBefore: number
  slotsRemaining: number
}

export function targetWinsForPlayers(uniquePlayers: number, winRatePercent: number): number {
  return Math.round((uniquePlayers * winRatePercent) / 100)
}

export function dailyQuotaSnapshot(ctx: DailyQuotaContext): DailyQuotaSnapshot {
  const uniquePlayersAfter = ctx.isFirstPlayToday
    ? ctx.uniquePlayersBefore + 1
    : ctx.uniquePlayersBefore

  const targetWins = targetWinsForPlayers(uniquePlayersAfter, ctx.winRatePercent)
  const targetBefore = targetWinsForPlayers(ctx.uniquePlayersBefore, ctx.winRatePercent)

  return {
    uniquePlayersAfter,
    targetWins,
    targetBefore,
    winsBefore: ctx.winsBefore,
    slotsRemaining: Math.max(0, targetWins - ctx.winsBefore),
  }
}

export function rollWinWithDailyQuota(
  ctx: DailyQuotaContext,
  rng: () => number = Math.random,
): boolean {
  if (ctx.customerAlreadyWonToday) return false

  const snap = dailyQuotaSnapshot(ctx)
  if (ctx.winsBefore >= snap.targetWins) return false

  if (ctx.isFirstPlayToday) {
    if (ctx.winsBefore < snap.targetBefore) return true
    const gap = snap.targetWins - ctx.winsBefore
    return rng() < gap
  }

  const slotsRemaining = snap.targetWins - ctx.winsBefore
  const nonWinnersRemaining = Math.max(1, snap.uniquePlayersAfter - ctx.winsBefore)
  return rng() < slotsRemaining / nonWinnersRemaining
}

export function simulateDay(
  uniquePlayers: number,
  winRatePercent: number,
  perDayUserLimit: number,
  rng: () => number = Math.random,
): number {
  let wins = 0
  let unique = 0
  for (let i = 0; i < uniquePlayers; i++) {
    const won = rollWinWithDailyQuota(
      {
        uniquePlayersBefore: unique,
        isFirstPlayToday: true,
        winsBefore: wins,
        winRatePercent,
        perDayUserLimit,
      },
      rng,
    )
    if (won) wins++
    unique++
  }
  return wins
}
