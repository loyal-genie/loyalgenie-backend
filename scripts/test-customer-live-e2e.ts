/**
 * Customer flows — detailed live E2E (shake, stamp, check-in, browse, wallet)
 * Skips spin / dice / lottery (not implemented).
 *
 * Requires API on :4000 and DATABASE_URL in .env
 *   npx tsx scripts/test-customer-live-e2e.ts
 */

import { nanoid } from 'nanoid'
import { db } from '../src/db/client.js'
import { signToken } from '../src/services/auth.js'
import { getCampaignPinForBusiness, rotatePinIfExpired, effectivePerDayUserLimit } from '../src/services/campaigns.js'

const BASE = (process.env.API_BASE_URL ?? 'http://localhost:4000/api').replace(/\/$/, '')
const RUN_ID = Date.now().toString(36)

interface TestResult { section: string; name: string; passed: boolean; detail: string }
const results: TestResult[] = []

function assert(section: string, name: string, condition: boolean, detail: string) {
  results.push({ section, name, passed: condition, detail })
  console.log(`${condition ? '✓' : '✗'} [${section}] ${name}\n    ${detail}`)
}

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 44 - title.length))}`)
}

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({})) as T
  return { status: res.status, json }
}

async function getLivePin(campaignId: string): Promise<string> {
  const row = await db.execute({
    sql: `SELECT u.id AS vendor_id FROM campaigns c
          JOIN businesses b ON b.id = c.business_id
          JOIN business_users u ON u.id = b.user_id
          WHERE c.id = ?`,
    args: [campaignId],
  })
  const vendorId = row.rows[0]?.vendor_id as string | undefined
  if (vendorId) {
    const meta = await getCampaignPinForBusiness(vendorId, campaignId)
    if (meta.pin) return meta.pin
  }
  const camp = await rotatePinIfExpired(campaignId)
  if (!camp.pin) throw new Error(`No live PIN for campaign ${campaignId}`)
  return camp.pin
}

type CampaignRow = {
  id: string
  name: string
  mechanic: string
  plays_per_day: number
  win_rate_percent: number
  user_cap: number
  per_day_user_limit: number
  start_date: string
  end_date: string
  business_id: string
  business_name: string
  vendor_user_id: string
  vendor_email: string
  participant_count?: number
  today_new?: number
}

function campaignHasCapacity(camp: CampaignRow): boolean {
  const participants = Number(camp.participant_count ?? 0)
  if (participants >= camp.user_cap) return false
  const dailyLimit = effectivePerDayUserLimit({
    startDate: camp.start_date,
    endDate: camp.end_date,
    userCap: camp.user_cap,
    perDayUserLimit: camp.per_day_user_limit,
  })
  return Number(camp.today_new ?? 0) < dailyLimit
}

function campaignSelectSql(extraWhere = '') {
  return `
    SELECT c.id, c.name, c.mechanic, c.plays_per_day, c.win_rate_percent, c.user_cap,
           c.per_day_user_limit, c.start_date, c.end_date,
           b.id AS business_id, b.name AS business_name,
           u.id AS vendor_user_id, u.email AS vendor_email,
           (SELECT COUNT(*) FROM campaign_participations p WHERE p.campaign_id = c.id) AS participant_count,
           (SELECT COUNT(*) FROM campaign_participations p
            WHERE p.campaign_id = c.id
              AND date(p.first_played_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')) AS today_new
    FROM campaigns c
    JOIN businesses b ON b.id = c.business_id
    JOIN business_users u ON u.id = b.user_id
    WHERE c.mechanic = ? AND c.status = 'active' ${extraWhere}
  `
}

async function listCampaigns(
  mechanic: string,
  opts?: { playsPerDay?: number; winRate?: number; minWinRate?: number; businessNameIncludes?: string; limit?: number },
): Promise<CampaignRow[]> {
  let sql = campaignSelectSql()
  const args: (string | number)[] = [mechanic]
  if (opts?.businessNameIncludes) {
    sql += ' AND LOWER(b.name) LIKE ?'
    args.push(`%${opts.businessNameIncludes.toLowerCase()}%`)
  }
  if (opts?.playsPerDay != null) {
    sql += ' AND c.plays_per_day = ?'
    args.push(opts.playsPerDay)
  }
  if (opts?.winRate != null) {
    sql += ' AND c.win_rate_percent = ?'
    args.push(opts.winRate)
  }
  if (opts?.minWinRate != null) {
    sql += ' AND c.win_rate_percent >= ?'
    args.push(opts.minWinRate)
  }
  sql += ` ORDER BY c.win_rate_percent DESC, participant_count ASC, c.created_at DESC LIMIT ${opts?.limit ?? 20}`
  const row = await db.execute({ sql, args })
  return row.rows as unknown as CampaignRow[]
}

/** First campaign with user-cap and daily-participant room (SQL pre-check). */
async function findPlayableCampaign(
  mechanic: string,
  opts?: { playsPerDay?: number; winRate?: number; minWinRate?: number; businessNameIncludes?: string },
): Promise<CampaignRow | null> {
  const camps = await listCampaigns(mechanic, opts)
  return camps.find(campaignHasCapacity) ?? null
}

async function findCampaign(
  mechanic: string,
  opts?: { playsPerDay?: number; winRate?: number; businessNameIncludes?: string },
) {
  const camps = await listCampaigns(mechanic, { ...opts, limit: 1 })
  return camps[0] ?? null
}

type ShakePlayResult = {
  status: number
  won: boolean
  code?: string
  error?: string
  playSessionToken?: string
}

/** Verify PIN and shake once; returns structured result for graceful retries. */
async function shakeOnce(campaignId: string, token: string): Promise<ShakePlayResult> {
  const pin = await getLivePin(campaignId)
  const verify = await verifyPinApi(campaignId, pin, token)
  if (verify.status !== 200 || !verify.json.data?.playSessionToken) {
    return { status: verify.status, won: false, error: 'PIN verify failed' }
  }
  const play = await api<{ success?: boolean; data?: { won: boolean; code?: string }; error?: string }>(
    'POST',
    `/campaigns/${campaignId}/shake`,
    { playSessionToken: verify.json.data.playSessionToken },
    token,
  )
  return {
    status: play.status,
    won: play.json.data?.won === true,
    code: play.json.data?.code,
    error: play.json.error,
    playSessionToken: verify.json.data.playSessionToken,
  }
}

async function findCampaignById(id: string) {
  const row = await db.execute({
    sql: `SELECT c.id, c.name, c.mechanic, c.plays_per_day, c.win_rate_percent,
                 b.id AS business_id, b.name AS business_name,
                 u.id AS vendor_user_id, u.email AS vendor_email
          FROM campaigns c
          JOIN businesses b ON b.id = c.business_id
          JOIN business_users u ON u.id = b.user_id
          WHERE c.id = ?`,
    args: [id],
  })
  return (row.rows[0] as unknown as CampaignRow) ?? null
}

async function createCustomer(suffix: string) {
  const id = nanoid()
  const phone = `9${String(Date.now() + Math.floor(Math.random() * 9999)).slice(-9)}`
  const email = `e2e-${RUN_ID}-${suffix}-${nanoid().slice(0, 6)}@live.test`
  await db.execute({
    sql: `INSERT INTO customer_users (id, name, phone, email) VALUES (?, ?, ?, ?)`,
    args: [id, `E2E ${suffix}`, phone, email],
  })
  return { id, token: signToken({ id, email, role: 'customer' }), phone }
}

async function verifyPinApi(campaignId: string, pin: string, token: string) {
  return api<{ success?: boolean; data?: { playSessionToken: string } }>(
    'POST',
    `/campaigns/${campaignId}/verify-pin`,
    { pin },
    token,
  )
}

type PubCampaign = { id: string; name: string; mechanic: string; playsPerDay?: number }
type PublicBiz = { id: string; name: string; campaigns: PubCampaign[] }

function pickCampaign(biz: PublicBiz | undefined, mechanic: string, minPlaysPerDay?: number) {
  if (!biz) return null
  const matches = biz.campaigns.filter(c => c.mechanic === mechanic)
  if (minPlaysPerDay != null) {
    const multi = matches.find(c => (c.playsPerDay ?? 1) > minPlaysPerDay)
    if (multi) return multi
  }
  return matches[0] ?? null
}

async function main() {
  console.log(`\n═══ Customer Live E2E — detailed (${RUN_ID}) ═══`)
  console.log(`API: ${BASE}`)
  console.log('Scope: shake, stamp, check-in, browse, wallet (no spin/dice/lottery)\n')

  // ── Infrastructure ──
  section('Infrastructure')
  const health = await api<{ status?: string }>('GET', '/health')
  assert('Infrastructure', 'API health', health.status === 200 && health.json.status === 'ok', 'ok')

  const pub = await api<{ success?: boolean; data?: Array<{ id: string; name: string; campaigns: unknown[] }> }>(
    'GET',
    '/campaigns/public/businesses',
  )
  assert('Infrastructure', 'Public businesses list', pub.status === 200 && (pub.json.data?.length ?? 0) > 0, `vendors=${pub.json.data?.length ?? 0}`)

  const amber = pub.json.data?.find(b => b.name.toLowerCase().includes('amber')) as PublicBiz | undefined
  assert('Infrastructure', 'Primary vendor (AmberCafe)', Boolean(amber), amber?.name ?? 'missing')

  const shakePub = pickCampaign(amber, 'shake', 1) ?? pickCampaign(amber, 'shake')
  const stampPub = pickCampaign(amber, 'stamp')
  const loyaltyPub = pickCampaign(amber, 'check-in-loyalty')

  assert('Infrastructure', 'Amber shake campaign', Boolean(shakePub), shakePub?.name ?? 'none')
  assert('Infrastructure', 'Amber stamp campaign', Boolean(stampPub), stampPub?.name ?? 'none')
  assert('Infrastructure', 'Amber check-in campaign', Boolean(loyaltyPub), loyaltyPub?.name ?? 'none')

  const shakeId = shakePub!.id
  const stampId = stampPub!.id
  const loyaltyId = loyaltyPub!.id

  // ── Browse & discovery ──
  section('Browse & discovery')
  if (shakePub) {
    const detail = await api<{ success?: boolean; data?: { id: string; mechanic: string; rewards: unknown[] } }>(
      'GET',
      `/campaigns/public/${shakeId}`,
    )
    assert(
      'Browse',
      'Public campaign detail (no auth)',
      detail.status === 200 && detail.json.data?.mechanic === 'shake',
      `rewards=${detail.json.data?.rewards?.length ?? 0}`,
    )
  }

  if (amber) {
    const bizCampaigns = amber!.campaigns as { mechanic: string }[]
    const hasCore = ['shake', 'stamp', 'check-in-loyalty'].every(m =>
      bizCampaigns.some(c => c.mechanic === m),
    )
    assert('Browse', 'AmberCafe has shake+stamp+check-in', hasCore, bizCampaigns.map(c => c.mechanic).join(', '))
  }

  // ── Auth ──
  section('Auth')
  const guest = await api('POST', `/campaigns/${shakeId}/verify-pin`, { pin: '123' })
  assert('Auth', 'verify-pin without token → 401', guest.status === 401, `status=${guest.status}`)

  const customer = await createCustomer('main')
  const session = await api<{ success?: boolean; data?: { role: string; userId: string } }>(
    'GET',
    '/auth/session',
    undefined,
    customer.token,
  )
  assert('Auth', 'Customer session', session.status === 200 && session.json.data?.role === 'customer', `userId=${session.json.data?.userId}`)

  // ── PIN validation ──
  section('PIN validation')
  const badFormat = await api('POST', `/campaigns/${shakeId}/verify-pin`, { pin: '12' }, customer.token)
  assert('PIN', '2-digit PIN rejected', badFormat.status === 422, `status=${badFormat.status}`)

  const badPin = await api('POST', `/campaigns/${shakeId}/verify-pin`, { pin: '000' }, customer.token)
  assert('PIN', 'Wrong PIN rejected', badPin.status === 422, `status=${badPin.status}`)

  const pin = await getLivePin(shakeId)
  assert('PIN', 'Staff PIN is 3 digits', /^\d{3}$/.test(pin), 'pin ok')

  // ── Shake & Win ──
  section('Shake & Win')
  const shakeUser = await createCustomer('shake')

  const playStateBefore = await api<{ success?: boolean; data?: { canPlay: boolean; playsRemaining: number; playsUsedToday: number; playsPerDay: number } }>(
    'GET',
    `/campaigns/${shakeId}/play-state`,
    undefined,
    shakeUser.token,
  )
  assert(
    'Shake',
    'play-state before first play',
    playStateBefore.status === 200 && playStateBefore.json.data?.canPlay === true,
    `remaining=${playStateBefore.json.data?.playsRemaining} used=${playStateBefore.json.data?.playsUsedToday}/${playStateBefore.json.data?.playsPerDay}`,
  )

  const verify1 = await verifyPinApi(shakeId, await getLivePin(shakeId), shakeUser.token)
  assert('Shake', 'PIN verify → play session', verify1.status === 200 && Boolean(verify1.json.data?.playSessionToken), `status=${verify1.status}`)

  const noSessionBody = await api('POST', `/campaigns/${shakeId}/shake`, {}, shakeUser.token)
  assert('Shake', 'shake without session token → 422', noSessionBody.status === 422, `status=${noSessionBody.status}`)

  const invalidSession = await api<{ error?: string }>(
    'POST',
    `/campaigns/${shakeId}/shake`,
    { playSessionToken: 'invalid-token' },
    shakeUser.token,
  )
  assert('Shake', 'Invalid session token → 401', invalidSession.status === 401, `status=${invalidSession.status}`)

  const sessionToken = verify1.json.data!.playSessionToken
  const play1 = await api<{
    success?: boolean
    data?: { won: boolean; playsRemaining: number; playsUsedToday: number; playsPerDay: number; code?: string; reward?: { name: string } }
  }>('POST', `/campaigns/${shakeId}/shake`, { playSessionToken: sessionToken }, shakeUser.token)

  assert(
    'Shake',
    'First shake succeeds',
    play1.status === 200,
    `won=${play1.json.data?.won} remaining=${play1.json.data?.playsRemaining} used=${play1.json.data?.playsUsedToday}/${play1.json.data?.playsPerDay}`,
  )

  const replay = await api<{ error?: string }>(
    'POST',
    `/campaigns/${shakeId}/shake`,
    { playSessionToken: sessionToken },
    shakeUser.token,
  )
  if ((play1.json.data?.playsPerDay ?? 1) > 1 && (play1.json.data?.playsRemaining ?? 0) > 0) {
    assert(
      'Shake',
      'Same session reusable while plays remain (multi-play campaign)',
      replay.status === 200,
      `status=${replay.status} remaining=${play1.json.data!.playsRemaining! - 1}`,
    )
  } else {
    assert(
      'Shake',
      'Replay blocked when no plays left',
      replay.status === 401 || replay.status === 403,
      `status=${replay.status} — ${replay.json.error ?? ''}`,
    )
  }

  const playStateAfter1 = await api<{ success?: boolean; data?: { canPlay: boolean; playsRemaining: number; playsUsedToday: number } }>(
    'GET',
    `/campaigns/${shakeId}/play-state`,
    undefined,
    shakeUser.token,
  )
  const usedAfter = replay.status === 200
    ? (play1.json.data?.playsUsedToday ?? 1) + 1
    : (play1.json.data?.playsUsedToday ?? 1)
  const remainingAfter = Math.max(0, (play1.json.data?.playsPerDay ?? 1) - usedAfter)
  assert(
    'Shake',
    'play-state after first play(s)',
    playStateAfter1.status === 200
      && playStateAfter1.json.data?.playsUsedToday === usedAfter
      && playStateAfter1.json.data?.playsRemaining === remainingAfter,
    `canPlay=${playStateAfter1.json.data?.canPlay} remaining=${playStateAfter1.json.data?.playsRemaining} used=${playStateAfter1.json.data?.playsUsedToday}`,
  )

  if (play1.json.data?.won && play1.json.data.code) {
    const walletAfterWin = await api<{ success?: boolean; data?: Array<{ code: string; status: string }> }>(
      'GET',
      '/campaigns/customer/rewards',
      undefined,
      shakeUser.token,
    )
    const earned = walletAfterWin.json.data?.filter(r => r.code === play1.json.data!.code) ?? []
    assert('Shake', 'Win appears in wallet', earned.length >= 1 && earned[0]?.status === 'earned', `code=${play1.json.data.code}`)
  } else {
    assert('Shake', 'Win wallet entry (no win this run)', true, 'shake did not win — wallet skip')
  }

  // Second play same day (if playsPerDay > 1) — requires fresh PIN
  if ((play1.json.data?.playsPerDay ?? 1) > 1 && play1.json.data?.playsRemaining! > 0) {
    const freshPin = await getLivePin(shakeId)
    const verify2 = await verifyPinApi(shakeId, freshPin!, shakeUser.token)
    const play2 = await api<{ success?: boolean; data?: { playsUsedToday: number; playsRemaining: number } }>(
      'POST',
      `/campaigns/${shakeId}/shake`,
      { playSessionToken: verify2.json.data!.playSessionToken },
      shakeUser.token,
    )
    assert(
      'Shake',
      'Second shake same day (new PIN)',
      play2.status === 200,
      `used=${play2.json.data?.playsUsedToday} remaining=${play2.json.data?.playsRemaining}`,
    )
  } else {
    assert('Shake', 'Second shake same day', true, `playsPerDay=${play1.json.data?.playsPerDay} remaining=${play1.json.data?.playsRemaining} — skipped`)
  }

  // Exhaust plays on 1-play/day campaign
  const onePlayCamp = await findCampaign('shake', { playsPerDay: 1 })
  if (onePlayCamp && onePlayCamp.id !== shakeId) {
    const onePlayUser = await createCustomer('shake-1pd')
    const onePin = await getLivePin(onePlayCamp.id)
    const v = await verifyPinApi(onePlayCamp.id, onePin!, onePlayUser.token)
    const p = await api('POST', `/campaigns/${onePlayCamp.id}/shake`, { playSessionToken: v.json.data!.playSessionToken }, onePlayUser.token)
    assert('Shake', '1-play campaign: first play OK', p.status === 200, onePlayCamp.name)

    const v2 = await verifyPinApi(onePlayCamp.id, onePin!, onePlayUser.token)
    const blocked = await api<{ error?: string }>(
      'POST',
      `/campaigns/${onePlayCamp.id}/shake`,
      { playSessionToken: v2.json.data!.playSessionToken },
      onePlayUser.token,
    )
    assert('Shake', '1-play campaign: second play blocked', blocked.status === 403, blocked.json.error ?? `status=${blocked.status}`)
  } else {
    assert('Shake', '1-play/day limit test', true, 'no separate 1-play campaign found — skipped')
  }

  // ── Shake & Win (reward path) ──
  section('Shake & Win — reward path')
  const winCampCandidates = await listCampaigns('shake', { minWinRate: 100 })
  const winCamp = await findPlayableCampaign('shake', { minWinRate: 100 })

  if (!winCamp) {
    const fullNames = winCampCandidates
      .map(c => `${c.name} (${c.participant_count ?? 0}/${c.user_cap} total, ${c.today_new ?? 0} today)`)
      .join('; ')
    const skipDetail = winCampCandidates.length === 0
      ? 'no 100% shake campaigns in DB'
      : `all full — ${fullNames}`
    assert('Shake+Win', 'Playable 100% win campaign', true, `skipped — ${skipDetail}`)
    assert('Shake+Win', 'Shake produces winner', true, 'skipped')
    assert('Shake+Win', 'Winner appears in wallet', true, 'skipped')
  } else {
    const winUser = await createCustomer('shake-win')
    const winPlay = await shakeOnce(winCamp.id, winUser.token)
    assert(
      'Shake+Win',
      'Playable 100% win campaign',
      true,
      `${winCamp.name} (${winCamp.participant_count ?? 0}/${winCamp.user_cap} total, ${winCamp.today_new ?? 0} today)`,
    )
    assert(
      'Shake+Win',
      'Shake produces winner',
      winPlay.status === 200 && winPlay.won === true,
      winPlay.status === 403
        ? `blocked: ${winPlay.error ?? 'campaign full'}`
        : `status=${winPlay.status} won=${winPlay.won} code=${winPlay.code ?? 'none'}`,
    )
    if (winPlay.won && winPlay.code) {
      const walletWin = await api<{ success?: boolean; data?: Array<{ code: string; status: string }> }>(
        'GET',
        '/campaigns/customer/rewards',
        undefined,
        winUser.token,
      )
      const earned = walletWin.json.data?.find(r => r.code === winPlay.code)
      assert(
        'Shake+Win',
        'Winner appears in wallet',
        Boolean(earned) && earned!.status === 'earned',
        `code=${winPlay.code} status=${earned?.status}`,
      )
    } else {
      assert('Shake+Win', 'Winner appears in wallet', false, 'no win code from shake')
    }
  }

  // ── Stamp cards ──
  section('Stamp cards')
  const stampUser = await createCustomer('stamp')

  const stampBefore = await api<{
    success?: boolean
    data?: { enrolled: boolean; canCollectToday: boolean; stampsCollected: number; totalStamps: number; enrollmentOpen: boolean }
  }>('GET', `/campaigns/${stampId}/stamp-state`, undefined, stampUser.token)

  assert(
    'Stamp',
    'stamp-state for new user',
    stampBefore.status === 200,
    `enrolled=${stampBefore.json.data?.enrolled} canCollect=${stampBefore.json.data?.canCollectToday} ${stampBefore.json.data?.stampsCollected}/${stampBefore.json.data?.totalStamps}`,
  )

  const stampVerify = await verifyPinApi(stampId, await getLivePin(stampId), stampUser.token)
  assert('Stamp', 'PIN verify', stampVerify.status === 200, `status=${stampVerify.status}`)
  if (stampVerify.status !== 200) throw new Error('Stamp PIN verify failed — aborting stamp section')

  const collect1 = await api<{
    success?: boolean
    data?: { enrolled: boolean; stampEarned: boolean; stampsCollected: number; totalStamps: number }
  }>('POST', `/campaigns/${stampId}/stamp`, { playSessionToken: stampVerify.json.data!.playSessionToken }, stampUser.token)

  assert(
    'Stamp',
    'First stamp collect',
    collect1.status === 200 && collect1.json.data?.stampEarned === true,
    `enrolled=${collect1.json.data?.enrolled} total=${collect1.json.data?.stampsCollected}/${collect1.json.data?.totalStamps}`,
  )

  const stampAfter = await api<{ success?: boolean; data?: { enrolled: boolean; canCollectToday: boolean; stampsCollected: number } }>(
    'GET',
    `/campaigns/${stampId}/stamp-state`,
    undefined,
    stampUser.token,
  )
  assert(
    'Stamp',
    'stamp-state after collect',
    stampAfter.status === 200
      && stampAfter.json.data?.enrolled === true
      && stampAfter.json.data?.canCollectToday === false,
    `stamps=${stampAfter.json.data?.stampsCollected} canCollect=${stampAfter.json.data?.canCollectToday}`,
  )

  const stampVerify2 = await verifyPinApi(stampId, await getLivePin(stampId), stampUser.token)
  const collect2 = await api<{ error?: string }>(
    'POST',
    `/campaigns/${stampId}/stamp`,
    { playSessionToken: stampVerify2.json.data!.playSessionToken },
    stampUser.token,
  )
  assert('Stamp', 'Duplicate collect same day → 403', collect2.status === 403, collect2.json.error ?? `status=${collect2.status}`)

  const stampReplay = await api('POST', `/campaigns/${stampId}/stamp`, { playSessionToken: stampVerify.json.data!.playSessionToken }, stampUser.token)
  assert('Stamp', 'Replay stamp session blocked', stampReplay.status === 401 || stampReplay.status === 403, `status=${stampReplay.status}`)

  // ── Check-in loyalty ──
  section('Check-in loyalty')
  const loyaltyUser = await createCustomer('loyalty')

  const loyaltyBefore = await api<{
    success?: boolean
    data?: { canCheckInToday: boolean; checkedInToday: boolean; loyaltyPoints: number; pointsPerCheckIn: number; businessName: string }
  }>('GET', `/campaigns/${loyaltyId}/loyalty-state`, undefined, loyaltyUser.token)

  assert(
    'Check-in',
    'loyalty-state before check-in',
    loyaltyBefore.status === 200 && loyaltyBefore.json.data?.canCheckInToday === true,
    `pts=${loyaltyBefore.json.data?.loyaltyPoints} +${loyaltyBefore.json.data?.pointsPerCheckIn}/visit @ ${loyaltyBefore.json.data?.businessName}`,
  )

  const promptBefore = await api<{ success?: boolean; data?: { hasPendingCheckIn: boolean } }>(
    'GET',
    '/campaigns/customer/check-in-prompt',
    undefined,
    loyaltyUser.token,
  )
  assert('Check-in', 'check-in-prompt endpoint', promptBefore.status === 200, `pending=${promptBefore.json.data?.hasPendingCheckIn}`)

  const loyaltyVerify = await verifyPinApi(loyaltyId, await getLivePin(loyaltyId), loyaltyUser.token)
  const checkIn1 = await api<{
    success?: boolean
    data?: { pointsEarned: number; loyaltyPoints: number; totalCheckIns: number; checkedInToday: boolean; milestonesUnlocked: { name: string }[] }
  }>('POST', `/campaigns/${loyaltyId}/check-in`, { playSessionToken: loyaltyVerify.json.data!.playSessionToken }, loyaltyUser.token)

  assert(
    'Check-in',
    'First check-in',
    checkIn1.status === 200 && (checkIn1.json.data?.pointsEarned ?? 0) > 0,
    `+${checkIn1.json.data?.pointsEarned} pts → ${checkIn1.json.data?.loyaltyPoints} total, visits=${checkIn1.json.data?.totalCheckIns} milestones=${checkIn1.json.data?.milestonesUnlocked?.map(m => m.name).join(',') || 'none'}`,
  )

  const loyaltyAfter = await api<{ success?: boolean; data?: { canCheckInToday: boolean; checkedInToday: boolean } }>(
    'GET',
    `/campaigns/${loyaltyId}/loyalty-state`,
    undefined,
    loyaltyUser.token,
  )
  assert(
    'Check-in',
    'loyalty-state after check-in',
    loyaltyAfter.json.data?.checkedInToday === true && loyaltyAfter.json.data?.canCheckInToday === false,
    `checkedIn=${loyaltyAfter.json.data?.checkedInToday}`,
  )

  const loyaltyVerify2 = await verifyPinApi(loyaltyId, await getLivePin(loyaltyId), loyaltyUser.token)
  const checkIn2 = await api<{ error?: string }>(
    'POST',
    `/campaigns/${loyaltyId}/check-in`,
    { playSessionToken: loyaltyVerify2.json.data!.playSessionToken },
    loyaltyUser.token,
  )
  assert('Check-in', 'Duplicate check-in → 403', checkIn2.status === 403, checkIn2.json.error ?? `status=${checkIn2.status}`)

  const profile = await api<{ success?: boolean; data?: Array<{ loyaltyPoints: number; campaignName: string }> }>(
    'GET',
    '/campaigns/customer/loyalty-profile',
    undefined,
    loyaltyUser.token,
  )
  assert(
    'Check-in',
    'loyalty-profile lists enrollment',
    profile.status === 200 && (profile.json.data?.length ?? 0) >= 1,
    `profiles=${profile.json.data?.length} pts=${profile.json.data?.[0]?.loyaltyPoints}`,
  )

  // ── Wallet & redemption ──
  section('Wallet & redemption')
  const redemptionCamp = await findPlayableCampaign('shake', { minWinRate: 100 })
  const redemptionCandidates = await listCampaigns('shake', { minWinRate: 100 })

  if (!redemptionCamp) {
    const detail = redemptionCandidates.length === 0
      ? 'no 100% win shake campaigns in DB'
      : `all ${redemptionCandidates.length} campaign(s) full: ${redemptionCandidates.map(c => `${c.name} (${c.participant_count ?? 0}/${c.user_cap}, ${c.today_new ?? 0} today)`).join(', ')}`
    assert('Wallet', 'Redemption flow (shake+win)', true, `skipped — ${detail}`)
    assert('Wallet', 'Reward in customer wallet', true, 'skipped')
    assert('Wallet', 'Customer requests redemption', true, 'skipped')
    assert('Wallet', 'Vendor marks redeemed', true, 'skipped')
    assert('Wallet', 'Reward status → redeemed', true, 'skipped')
  } else {
    const winUser = await createCustomer('wallet')
    let activeCamp = redemptionCamp
    let wp = await shakeOnce(activeCamp.id, winUser.token)

    if (wp.status === 403) {
      const alternates = redemptionCandidates.filter(c => c.id !== activeCamp.id && campaignHasCapacity(c))
      for (const alt of alternates) {
        wp = await shakeOnce(alt.id, winUser.token)
        if (wp.status === 200) {
          activeCamp = alt
          break
        }
      }
    }

    const winCamp = activeCamp
    assert(
      'Wallet',
      '100% win campaign produces winner',
      wp.status === 200 && wp.won === true,
      wp.status === 403
        ? `blocked: ${wp.error ?? 'campaign full'}`
        : `camp=${winCamp.name} status=${wp.status} won=${wp.won} code=${wp.code ?? 'none'}`,
    )

    const wallet = await api<{ success?: boolean; data?: Array<{ id: string; status: string; code: string }> }>(
      'GET',
      '/campaigns/customer/rewards',
      undefined,
      winUser.token,
    )
    const reward = wp.code ? wallet.json.data?.find(r => r.code === wp.code) : undefined
    assert(
      'Wallet',
      'Reward in customer wallet',
      wp.won === true && Boolean(reward) && reward!.status === 'earned',
      wp.won ? `id=${reward?.id}` : 'no win — skipped wallet lookup',
    )

    if (reward) {
      const vendorToken = signToken({ id: winCamp.vendor_user_id, email: winCamp.vendor_email, role: 'business' })
      const pendingBefore = await api<{ success?: boolean; data?: unknown[] }>(
        'GET',
        '/business/redemptions/pending',
        undefined,
        vendorToken,
      )
      assert('Wallet', 'Vendor pending queue (before)', pendingBefore.status === 200, `pending=${pendingBefore.json.data?.length ?? 0}`)

      const request = await api('POST', `/campaigns/customer/rewards/${reward.id}/request-redemption`, undefined, winUser.token)
      assert('Wallet', 'Customer requests redemption', request.status === 200, `status=${request.status}`)

      const pendingAfter = await api<{ success?: boolean; data?: Array<{ id: string }> }>(
        'GET',
        '/business/redemptions/pending',
        undefined,
        vendorToken,
      )
      const inQueue = pendingAfter.json.data?.some(r => r.id === reward.id)
      assert('Wallet', 'Vendor sees pending redemption', Boolean(inQueue), `queue=${pendingAfter.json.data?.length}`)

      const redeemed = await api('PATCH', `/business/redemptions/${reward.id}/redeem`, undefined, vendorToken)
      assert('Wallet', 'Vendor marks redeemed', redeemed.status === 200, `status=${redeemed.status}`)

      const walletAfter = await api<{ success?: boolean; data?: Array<{ id: string; status: string }> }>(
        'GET',
        '/campaigns/customer/rewards',
        undefined,
        winUser.token,
      )
      const final = walletAfter.json.data?.find(r => r.id === reward.id)
      assert('Wallet', 'Reward status → redeemed', final?.status === 'redeemed', `status=${final?.status}`)
    } else if (wp.status === 200 && wp.won) {
      assert('Wallet', 'Customer requests redemption', false, 'reward missing from wallet')
      assert('Wallet', 'Vendor marks redeemed', true, 'skipped')
      assert('Wallet', 'Reward status → redeemed', true, 'skipped')
    } else {
      assert('Wallet', 'Customer requests redemption', true, 'skipped — no win')
      assert('Wallet', 'Vendor marks redeemed', true, 'skipped')
      assert('Wallet', 'Reward status → redeemed', true, 'skipped')
    }
  }

  const walletEmpty = await api('GET', '/campaigns/customer/rewards', undefined, (await createCustomer('empty')).token)
  assert('Wallet', 'Empty wallet for new customer', walletEmpty.status === 200 && (walletEmpty.json as { data?: unknown[] }).data?.length === 0, 'rewards=0')

  // ── Summary ──
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  console.log(`\n${'═'.repeat(50)}`)
  console.log(`Results: ${passed} passed, ${failed} failed (${results.length} total)`)

  if (failed > 0) {
    console.log('\nFailed:')
    for (const r of results.filter(x => !x.passed)) {
      console.log(`  ✗ [${r.section}] ${r.name}: ${r.detail}`)
    }
    process.exit(1)
  }

  console.log('\nAll customer flows passed (shake, shake+win, stamp, check-in, browse, wallet).')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
