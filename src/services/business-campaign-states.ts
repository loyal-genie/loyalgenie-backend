import { db } from '../db/client.js'
import { todayInCampaignTz } from '../utils/campaign-dates.js'
import { getPlayState } from './campaigns.js'
import { getStampState } from './stamp-cards.js'
import { getLoyaltyState } from './check-in-loyalty.js'

export interface BusinessCampaignStateItem {
  campaignId: string
  mechanic: string
  state: Awaited<ReturnType<typeof getPlayState>>
    | Awaited<ReturnType<typeof getStampState>>
    | Awaited<ReturnType<typeof getLoyaltyState>>
    | null
}

export async function getBusinessCampaignStates(
  businessId: string,
  customerId: string,
): Promise<BusinessCampaignStateItem[]> {
  const today = todayInCampaignTz()
  const result = await db.execute({
    sql: `SELECT id, mechanic FROM campaigns
          WHERE business_id = ? AND status = 'active' AND start_date <= ?`,
    args: [businessId, today],
  })

  return Promise.all(
    result.rows.map(async row => {
      const campaignId = row.id as string
      const mechanic = row.mechanic as string

      if (mechanic === 'stamp') {
        return { campaignId, mechanic, state: await getStampState(campaignId, customerId) }
      }
      if (mechanic === 'shake') {
        return { campaignId, mechanic, state: await getPlayState(campaignId, customerId) }
      }
      if (mechanic === 'check-in-loyalty') {
        return { campaignId, mechanic, state: await getLoyaltyState(campaignId, customerId) }
      }

      return { campaignId, mechanic, state: null }
    }),
  )
}
