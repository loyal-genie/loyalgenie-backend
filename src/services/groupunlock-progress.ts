import { db } from '../db/client.js'
import { parseGroupUnlockConfig } from './groupunlock-campaign-schema.js'

/** Promote all reserved spots to redeemable once the target is met. */
export async function maybeUnlockGroupRewards(campaignId: string): Promise<boolean> {
  const result = await db.execute({
    sql: `SELECT config_json FROM campaigns WHERE id = ? AND mechanic = 'groupunlock'`,
    args: [campaignId],
  })
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) return false
  const config = parseGroupUnlockConfig((row.config_json as string) ?? null)
  if (!config) return false

  const claimedCount = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM customer_rewards
          WHERE campaign_id = ? AND source_type = 'groupunlock'
            AND status IN ('group_pending', 'earned', 'pending', 'redeemed')`,
    args: [campaignId],
  })
  const joined = Number(claimedCount.rows[0]?.c ?? 0)
  if (joined < config.targetParticipants) return false

  await db.execute({
    sql: `UPDATE customer_rewards
          SET status = 'earned'
          WHERE campaign_id = ? AND source_type = 'groupunlock' AND status = 'group_pending'`,
    args: [campaignId],
  })
  return true
}

export async function getGroupUnlockProgress(campaignId: string) {
  const result = await db.execute({
    sql: `SELECT config_json FROM campaigns WHERE id = ? AND mechanic = 'groupunlock'`,
    args: [campaignId],
  })
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  const config = parseGroupUnlockConfig((row.config_json as string) ?? null)
  if (!config) return null

  const claimedCount = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM customer_rewards
          WHERE campaign_id = ? AND source_type = 'groupunlock'
            AND status IN ('group_pending', 'earned', 'pending', 'redeemed')`,
    args: [campaignId],
  })
  const joined = Number(claimedCount.rows[0]?.c ?? 0)
  const target = config.targetParticipants
  return {
    targetParticipants: target,
    groupJoined: joined,
    peopleLeft: Math.max(0, target - joined),
    unlocked: joined >= target,
  }
}
