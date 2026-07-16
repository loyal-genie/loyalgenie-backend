import { runDueLotteryDraws } from './lottery-service.js'

const TICK_MS = Number(process.env.LOTTERY_DRAW_SCHEDULER_INTERVAL_MS ?? 60_000)

const verbose = () =>
  process.env.LOTTERY_DRAW_SCHEDULER_VERBOSE === '1' || process.env.NODE_ENV !== 'production'

export function startLotteryDrawScheduler(): ReturnType<typeof setInterval> {
  const tick = async () => {
    try {
      const count = await runDueLotteryDraws()
      if (count > 0 && verbose()) {
        console.log(`[lottery-draw-scheduler] completed ${count} draw(s)`)
      }
    } catch (err) {
      console.error('[lottery-draw-scheduler] tick error:', err)
    }
  }

  void tick()
  return setInterval(() => void tick(), TICK_MS)
}
