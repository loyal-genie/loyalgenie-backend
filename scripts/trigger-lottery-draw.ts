/**
 * Manual Lottery Draw Trigger
 * Usage: npx ts-node scripts/trigger-lottery-draw.ts <campaignId>
 * 
 * Manually executes draw for a specific campaign (for testing without waiting)
 */

import { executeLotteryDraw } from '../src/services/lottery-service.js'
import { db } from '../src/db/client.js'

async function main() {
  const campaignId = process.argv[2]
  if (!campaignId) {
    console.error('Usage: npx ts-node scripts/trigger-lottery-draw.ts <campaignId>')
    process.exit(1)
  }

  console.log(`🎟️ Triggering lottery draw for campaign: ${campaignId}\n`)

  // Verify campaign exists
  const campaignRes = await db.execute({
    sql: 'SELECT id, name, status, end_date, end_time FROM campaigns WHERE id = ?',
    args: [campaignId],
  })

  if (campaignRes.rows.length === 0) {
    console.error(`❌ Campaign not found: ${campaignId}`)
    process.exit(1)
  }

  const campaign = campaignRes.rows[0]
  console.log(`Campaign: ${campaign.name as string}`)
  console.log(`Status: ${campaign.status as string}`)
  console.log(`Draw date: ${campaign.end_date as string} ${campaign.end_time as string}\n`)

  // Get ticket count
  const ticketRes = await db.execute({
    sql: 'SELECT COUNT(*) as c FROM lottery_tickets WHERE campaign_id = ?',
    args: [campaignId],
  })
  const ticketCount = ticketRes.rows[0]?.c as number

  console.log(`Total tickets: ${ticketCount}`)
  if (ticketCount === 0) {
    console.warn('⚠️  No tickets to draw!')
    process.exit(0)
  }

  // Execute draw
  try {
    const drew = await executeLotteryDraw(campaignId)
    if (drew) {
      console.log('✅ Draw completed successfully!\n')

      // Show results
      const winnersRes = await db.execute({
        sql: `SELECT COUNT(*) as c FROM lottery_tickets WHERE campaign_id = ? AND status = 'won'`,
        args: [campaignId],
      })
      const winCount = winnersRes.rows[0]?.c as number

      const losersRes = await db.execute({
        sql: `SELECT COUNT(*) as c FROM lottery_tickets WHERE campaign_id = ? AND status = 'lost'`,
        args: [campaignId],
      })
      const loseCount = losersRes.rows[0]?.c as number

      const notifRes = await db.execute({
        sql: 'SELECT type, COUNT(*) as c FROM customer_notifications WHERE campaign_id = ? GROUP BY type',
        args: [campaignId],
      })

      console.log(`📊 Results:`)
      console.log(`  Winners: ${winCount}`)
      console.log(`  Losers: ${loseCount}`)
      console.log(`  Notifications sent:`)
      notifRes.rows.forEach(row => {
        console.log(`    - ${row.type as string}: ${row.c as number}`)
      })
    } else {
      console.log('⚠️  Draw was not executed (may already be completed or not due)')
    }
  } catch (err) {
    console.error(`❌ Draw failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  process.exit(0)
}

main()
