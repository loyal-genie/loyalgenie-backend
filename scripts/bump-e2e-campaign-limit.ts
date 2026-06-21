/**
 * Bump daily participant limit on the 100% win shake campaign used by E2E tests.
 *   npx tsx scripts/bump-e2e-campaign-limit.ts
 */
import { db } from '../src/db/client.js'

const NEW_DAILY_LIMIT = 500

async function main() {
  const before = await db.execute({
    sql: `SELECT c.id, c.name, c.user_cap, c.per_day_user_limit, c.win_rate_percent,
                 (SELECT COUNT(*) FROM campaign_participations p WHERE p.campaign_id = c.id) AS participants,
                 (SELECT COUNT(*) FROM campaign_participations p
                  WHERE p.campaign_id = c.id
                    AND date(p.first_played_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')) AS today_new
          FROM campaigns c
          WHERE c.mechanic = 'shake' AND c.win_rate_percent = 100 AND c.status = 'active'
          ORDER BY c.created_at DESC`,
    args: [],
  })

  if (before.rows.length === 0) {
    console.log('No active 100% shake campaigns found.')
    return
  }

  for (const row of before.rows) {
    const id = row.id as string
    await db.execute({
      sql: `UPDATE campaigns SET per_day_user_limit = ? WHERE id = ?`,
      args: [NEW_DAILY_LIMIT, id],
    })
    console.log(
      `Updated ${row.name} (${id}): per_day_user_limit ${row.per_day_user_limit} → ${NEW_DAILY_LIMIT}` +
        ` | participants ${row.participants}/${row.user_cap}, today ${row.today_new}`,
    )
  }

  const after = await db.execute({
    sql: `SELECT id, name, per_day_user_limit, user_cap FROM campaigns WHERE mechanic = 'shake' AND win_rate_percent = 100 AND status = 'active'`,
    args: [],
  })
  console.log('\nAfter:', JSON.stringify(after.rows, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
