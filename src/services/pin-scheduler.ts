import { db } from '../db/client.js'
import { rotatePinIfExpired } from './campaigns.js'

/** How often we scan for expired PINs (server-side rotation → Supabase Realtime). */
const TICK_MS = Number(process.env.PIN_SCHEDULER_INTERVAL_MS ?? 10_000)

const verbose = () =>
  process.env.PIN_SCHEDULER_VERBOSE === '1' || process.env.NODE_ENV !== 'production'

/**
 * Rotate PINs whose window has ended. Without this, rotation only happens when
 * a client calls the PIN API — dashboards would stall at 0s until someone polls.
 */
export async function rotateAllExpiredPins(): Promise<number> {
  const nowIso = new Date().toISOString()
  const result = await db.execute({
    sql: `SELECT id FROM campaigns
          WHERE pin_expires_at IS NOT NULL
            AND pin_expires_at <= ?`,
    args: [nowIso],
  })

  if (result.rows.length === 0) return 0

  for (const row of result.rows) {
    const id = row.id as string
    try {
      await rotatePinIfExpired(id)
    } catch (err) {
      console.error(`[pin-scheduler] failed to rotate campaign ${id}:`, err)
    }
  }
  return result.rows.length
}

export function startPinScheduler(): ReturnType<typeof setInterval> {
  const tick = async () => {
    try {
      const count = await rotateAllExpiredPins()
      if (count > 0 && verbose()) {
        console.log(`[pin-scheduler] processed ${count} expired PIN(s)`)
      }
    } catch (err) {
      console.error('[pin-scheduler] tick error:', err)
    }
  }

  void tick()
  return setInterval(() => void tick(), TICK_MS)
}
