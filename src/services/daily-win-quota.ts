/**
 * Daily win quota — matches UI: "X% of each day's players will win."
 *
 * ## Definitions
 * - **Player** = unique customer playing today. Quota is based on player count N.
 * - **Daily target** = `round(N × winRate%)` wins when N players have played.
 *   Example: 50 players × 5% → **3 wins** that day. 10 players × 5% → **1 win**.
 *
 * ## Who wins?
 * Uses a **gap-based lottery** (deterministic guarantee + probability):
 *
 * When a new player shakes (first play today):
 *   - `targetBefore = round(playersBefore × rate)`
 *   - `targetNow    = round(playersAfter  × rate)`
 *   - If `wins < targetBefore` → **must win** (catch up)
 *   - If `wins >= targetNow`    → **must lose** (quota full)
 *   - Else → win with probability `gap / 1` where `gap = targetNow - wins`
 *     (random 0.4 with gap=1 always wins; gap is the number of win slots left)
 *
 * Repeat play same day (2nd shake): while `wins < target` for current player count,
 * use `winRate%` random chance.
 *
 * With 1 play/user/day this yields **exactly** `round(N × rate%)` wins after N players.
 */

export interface DailyQuotaContext {
  uniquePlayersBefore: number
  isFirstPlayToday: boolean
  winsBefore: number
  winRatePercent: number
  /** Kept for API compatibility / future tuning; not required for gap math. */
  perDayUserLimit: number
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
  const snap = dailyQuotaSnapshot(ctx)

  if (ctx.isFirstPlayToday) {
    if (ctx.winsBefore >= snap.targetWins) {
      return false
    }
    if (ctx.winsBefore < snap.targetBefore) {
      return true
    }
    const gap = snap.targetWins - ctx.winsBefore
    return rng() < gap
  }

  // Repeat play — probability while daily slots remain
  if (ctx.winsBefore >= snap.targetWins) {
    return false
  }
  return rng() < ctx.winRatePercent / 100
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
