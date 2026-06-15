/**
 * Shake & Win — 10-user cap E2E scenario
 *
 * Creates a campaign (cap=10, 30% win rate), deep-tests PIN logic (120s cycle,
 * wrong/correct PIN, grace window, rotation), then has 10 customers sign in,
 * verify PIN, play, and asserts win count matches daily quota.
 *
 * Usage (backend must be running):
 *   npm run test:shake:e2e
 */

import { db } from '../src/db/client.js'
import { PIN_CYCLE_SECONDS } from '../src/services/campaigns.js'
import { targetWinsForPlayers } from '../src/services/daily-win-quota.js'

const BASE = (process.env.API_BASE_URL ?? 'http://localhost:4000/api').replace(/\/$/, '')
const RUN_ID = `e2e-${Date.now().toString(36)}`
const WIN_RATE = 30
const USER_CAP = 10
const PIN_GRACE_SECONDS = 45

interface TestResult {
  name: string
  passed: boolean
  detail: string
}

const results: TestResult[] = []

function assert(name: string, condition: boolean, detail: string) {
  results.push({ name, passed: condition, detail })
  console.log(`${condition ? '✓' : '✗'} ${name}\n    ${detail}`)
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

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function daysFromNow(n: number) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

function wrongPinFor(correct: string): string {
  const n = parseInt(correct, 10)
  const alt = ((n + 111) % 900) + 100
  return String(alt).padStart(3, '0')
}

async function setupVendor() {
  const email = `vendor-${RUN_ID}@e2e-test.local`
  const password = 'TestPass123!'

  const signup = await api<{ data?: { token: string } }>(
    'POST', '/auth/business/signup', { email, password },
  )
  if (signup.status !== 201) throw new Error(`Vendor signup failed: ${signup.status}`)

  const onboard = await api<{ data?: { token?: string } }>(
    'POST', '/onboarding/complete',
    {
      name: `E2E Cafe ${RUN_ID}`,
      businessType: 'Cafe',
      ownerName: 'E2E Owner',
      mobile: '9876543210',
      email,
      password,
      city: 'Mumbai',
    },
    signup.json.data!.token,
  )
  if (onboard.status !== 201) throw new Error(`Onboarding failed: ${onboard.status}`)

  return onboard.json.data?.token ?? signup.json.data!.token
}

async function signupCustomer(index: number) {
  const email = `player-${RUN_ID}-${index}@e2e-test.local`
  const phone = String(7000000000 + index + (parseInt(RUN_ID.split('-')[1] ?? '0', 36) % 100000)).slice(0, 10)
  const res = await api<{ data?: { token: string; userId: string } }>(
    'POST', '/auth/customer/signup',
    { name: `Player ${index}`, phone, email, password: 'TestPass123!' },
  )
  if (res.status !== 201) throw new Error(`Customer ${index} signup: ${res.status}`)
  return { token: res.json.data!.token, userId: res.json.data!.userId, email }
}

async function signInCustomer(email: string, password = 'TestPass123!') {
  const res = await api<{ data?: { token: string; userId: string } }>(
    'POST', '/auth/customer/signin', { email, password },
  )
  if (res.status !== 200) throw new Error(`Customer signin failed: ${res.status}`)
  return { token: res.json.data!.token, userId: res.json.data!.userId, email }
}

async function getPinMeta(vendorToken: string, campaignId: string) {
  const res = await api<{
    data?: { pin: string; secondsRemaining: number; cycleSeconds: number; expiresAt: string }
  }>('GET', `/campaigns/${campaignId}/pin`, undefined, vendorToken)
  if (res.status !== 200 || !res.json.data?.pin) {
    throw new Error(`PIN fetch failed: ${res.status}`)
  }
  return res.json.data
}

async function verifyPin(customerToken: string, campaignId: string, pin: string) {
  return api<{ success?: boolean; data?: { playSessionToken: string }; error?: string }>(
    'POST', `/campaigns/${campaignId}/verify-pin`, { pin }, customerToken,
  )
}

async function shake(customerToken: string, campaignId: string, playSessionToken: string) {
  return api<{ data?: { won: boolean; playsRemaining: number }; error?: string }>(
    'POST', `/campaigns/${campaignId}/shake`, { playSessionToken }, customerToken,
  )
}

async function getCampaign(vendorToken: string, campaignId: string) {
  return api<{ data?: { currentUsers: number; participations: number; rewardsClaimed: number; userCap: number; winRatePercent: number } }>(
    'GET', `/campaigns/${campaignId}`, undefined, vendorToken,
  )
}

async function readDbPin(campaignId: string) {
  const row = await db.execute({
    sql: 'SELECT pin, pin_expires_at FROM campaigns WHERE id = ?',
    args: [campaignId],
  })
  return {
    pin: row.rows[0]?.pin as string | null,
    pinExpiresAt: row.rows[0]?.pin_expires_at as string | null,
  }
}

async function setPinExpiresAt(campaignId: string, iso: string) {
  await db.execute({
    sql: 'UPDATE campaigns SET pin_expires_at = ? WHERE id = ?',
    args: [iso, campaignId],
  })
}

async function runPinDeepTests(
  vendorToken: string,
  campaignId: string,
  probeCustomer: { token: string },
) {
  console.log('\n── PIN logic (120s cycle, grace, rotation) ──\n')

  const meta = await getPinMeta(vendorToken, campaignId)
  assert(
    'PIN cycle is 120 seconds',
    meta.cycleSeconds === PIN_CYCLE_SECONDS,
    `cycleSeconds=${meta.cycleSeconds} expected=${PIN_CYCLE_SECONDS}`,
  )
  assert(
    'Live PIN has time remaining within 120s window',
    meta.secondsRemaining > 0 && meta.secondsRemaining <= PIN_CYCLE_SECONDS,
    `secondsRemaining=${meta.secondsRemaining}`,
  )

  const dbPin = await readDbPin(campaignId)
  assert(
    'Vendor PIN matches database PIN',
    dbPin.pin === meta.pin,
    `vendor=${meta.pin} db=${dbPin.pin}`,
  )

  const bad = wrongPinFor(meta.pin)
  assert('Wrong PIN differs from live PIN', bad !== meta.pin, `bad=${bad} live=${meta.pin}`)

  const wrongRes = await verifyPin(probeCustomer.token, campaignId, bad)
  assert(
    'Wrong PIN returns 422 (not 401)',
    wrongRes.status === 422 && wrongRes.json.error?.includes('Wrong PIN'),
    `status=${wrongRes.status} error=${wrongRes.json.error}`,
  )

  const noAuth = await api('POST', `/campaigns/${campaignId}/verify-pin`, { pin: meta.pin })
  assert(
    'verify-pin without auth returns 401',
    noAuth.status === 401,
    `status=${noAuth.status}`,
  )

  const good = await verifyPin(probeCustomer.token, campaignId, meta.pin)
  assert(
    'Correct PIN within 120s cycle accepted',
    good.status === 200 && Boolean(good.json.data?.playSessionToken),
    `status=${good.status} error=${good.json.error ?? 'ok'}`,
  )

  const sessionRes = await api<{ data?: { role: string } }>(
    'GET', '/auth/session', undefined, probeCustomer.token,
  )
  assert(
    'Customer auth session valid before shake',
    sessionRes.status === 200 && sessionRes.json.data?.role === 'customer',
    `status=${sessionRes.status}`,
  )

  // Grace: PIN expired 30s ago but within 45s grace
  const gracePin = meta.pin
  await setPinExpiresAt(campaignId, new Date(Date.now() - 30_000).toISOString())
  const graceCustomer = await signupCustomer(901)
  const graceRes = await verifyPin(graceCustomer.token, campaignId, gracePin)
  assert(
    'PIN expired 30s ago still accepted (45s grace)',
    graceRes.status === 200,
    `status=${graceRes.status} error=${graceRes.json.error}`,
  )

  // Beyond grace: expired 60s ago → reject and rotate
  const stalePin = (await readDbPin(campaignId)).pin!
  await setPinExpiresAt(campaignId, new Date(Date.now() - 60_000).toISOString())
  const staleCustomer = await signupCustomer(902)
  const staleRes = await verifyPin(staleCustomer.token, campaignId, stalePin)
  assert(
    'PIN expired 60s ago rejected (beyond grace)',
    staleRes.status === 422,
    `status=${staleRes.status} error=${staleRes.json.error}`,
  )

  const afterRotate = await getPinMeta(vendorToken, campaignId)
  assert(
    'Vendor PIN rotated after stale rejection',
    afterRotate.pin !== stalePin,
    `old=${stalePin} new=${afterRotate.pin}`,
  )

  const oldPinFail = await verifyPin(staleCustomer.token, campaignId, stalePin)
  assert(
    'Old PIN fails after rotation',
    oldPinFail.status === 422,
    `status=${oldPinFail.status}`,
  )

  const newPinOk = await verifyPin(staleCustomer.token, campaignId, afterRotate.pin)
  assert(
    'New PIN works after rotation',
    newPinOk.status === 200,
    `status=${newPinOk.status} error=${newPinOk.json.error}`,
  )

  // Same PIN usable multiple times within cycle (different customers)
  const pinAgain = await getPinMeta(vendorToken, campaignId)
  const cA = await signupCustomer(903)
  const cB = await signupCustomer(904)
  const vA = await verifyPin(cA.token, campaignId, pinAgain.pin)
  const vB = await verifyPin(cB.token, campaignId, pinAgain.pin)
  assert(
    'Same live PIN works for multiple customers in same cycle',
    vA.status === 200 && vB.status === 200,
    `A=${vA.status} B=${vB.status}`,
  )
}

async function runTenUserScenario(vendorToken: string, campaignId: string) {
  console.log('\n── 10 users: signup/signin → PIN → shake ──\n')

  const expectedWins = targetWinsForPlayers(USER_CAP, WIN_RATE)
  console.log(`    Expected wins when cap fills: round(${USER_CAP} × ${WIN_RATE}%) = ${expectedWins}\n`)

  const players: Array<{ token: string; email: string; index: number }> = []
  let apiWins = 0

  for (let i = 1; i <= USER_CAP; i++) {
    let customer: { token: string; email: string }

    if (i === 1) {
      const signedUp = await signupCustomer(i)
      customer = { token: signedUp.token, email: signedUp.email }
      const signedIn = await signInCustomer(signedUp.email)
      assert(
        'Player 1 sign-in returns valid token',
        signedIn.token.length > 20,
        `token length=${signedIn.token.length}`,
      )
      customer.token = signedIn.token
    } else {
      const signedUp = await signupCustomer(i)
      customer = { token: signedUp.token, email: signedUp.email }
    }

    players.push({ ...customer, index: i })

    const pinMeta = await getPinMeta(vendorToken, campaignId)
    assert(
      `Player ${i}: live PIN available (${pinMeta.secondsRemaining}s left)`,
      pinMeta.secondsRemaining > 0,
      `pin=${pinMeta.pin} remaining=${pinMeta.secondsRemaining}s`,
    )

    const verified = await verifyPin(customer.token, campaignId, pinMeta.pin)
    assert(
      `Player ${i}: correct PIN verified`,
      verified.status === 200 && Boolean(verified.json.data?.playSessionToken),
      `status=${verified.status} error=${verified.json.error ?? 'ok'}`,
    )

    const play = await shake(customer.token, campaignId, verified.json.data!.playSessionToken)
    assert(
      `Player ${i}: shake succeeds`,
      play.status === 200,
      `status=${play.status} won=${play.json.data?.won} error=${play.json.error}`,
    )

    if (play.json.data?.won) apiWins++

    const stats = await getCampaign(vendorToken, campaignId)
    assert(
      `Player ${i}: currentUsers = ${i}`,
      stats.json.data?.currentUsers === i,
      `currentUsers=${stats.json.data?.currentUsers}`,
    )
    assert(
      `Player ${i}: participations = ${i}`,
      stats.json.data?.participations === i,
      `participations=${stats.json.data?.participations}`,
    )
  }

  const finalStats = await getCampaign(vendorToken, campaignId)
  const claimed = finalStats.json.data?.rewardsClaimed ?? -1

  assert(
    'Campaign filled: exactly 10 unique users',
    finalStats.json.data?.currentUsers === USER_CAP,
    `currentUsers=${finalStats.json.data?.currentUsers}`,
  )
  assert(
    'Campaign filled: exactly 10 plays recorded',
    finalStats.json.data?.participations === USER_CAP,
    `participations=${finalStats.json.data?.participations}`,
  )
  assert(
    `Win count matches ${WIN_RATE}% quota (API responses)`,
    apiWins === expectedWins,
    `apiWins=${apiWins} expected=${expectedWins}`,
  )
  assert(
    `Win count matches ${WIN_RATE}% quota (rewardsClaimed)`,
    claimed === expectedWins,
    `rewardsClaimed=${claimed} expected=${expectedWins}`,
  )

  console.log(
    `\n    ✓ ${USER_CAP} players → ${apiWins} wins (= round(${USER_CAP} × ${WIN_RATE}%) = ${expectedWins})`,
  )

  // 11th player blocked
  const eleventh = await signupCustomer(999)
  const pinMeta = await getPinMeta(vendorToken, campaignId)
  const verified = await verifyPin(eleventh.token, campaignId, pinMeta.pin)
  assert(
    '11th player: PIN still verifies (cap enforced at shake)',
    verified.status === 200,
    `status=${verified.status}`,
  )
  const blocked = await shake(eleventh.token, campaignId, verified.json.data!.playSessionToken)
  assert(
    '11th player blocked at user cap',
    blocked.status === 403,
    `status=${blocked.status} error=${blocked.json.error}`,
  )

  return { apiWins, expectedWins, claimed }
}

async function main() {
  console.log(`\n${'═'.repeat(56)}`)
  console.log(` Shake & Win E2E — 10-user cap + PIN deep test`)
  console.log(` Run ID: ${RUN_ID}`)
  console.log(` API: ${BASE}`)
  console.log(`${'═'.repeat(56)}`)

  const healthRes = await fetch(`${BASE}/health`)
  const healthJson = await healthRes.json() as { status?: string }
  assert('API health', healthRes.ok && healthJson.status === 'ok', `${healthRes.status}`)

  const vendorToken = await setupVendor()
  assert('Vendor ready', Boolean(vendorToken), 'token obtained')

  const create = await api<{ data?: { id: string; pin: string; userCap: number; winRatePercent: number } }>(
    'POST', '/campaigns',
    {
      name: `E2E 10-user ${RUN_ID}`,
      mechanic: 'shake',
      startDate: todayStr(),
      endDate: daysFromNow(30),
      userCap: USER_CAP,
      perDayUserLimit: USER_CAP,
      playsPerDay: 1,
      winRatePercent: WIN_RATE,
      rewards: [
        { name: 'Free Coffee', icon: '☕', sharePercent: 90 },
        { name: '10% Off', icon: '🏷️', sharePercent: 10 },
      ],
    },
    vendorToken,
  )
  assert(
    'Create campaign (cap=10, 30% win rate)',
    create.status === 201,
    `status=${create.status}`,
  )

  const campaignId = create.json.data!.id
  assert(
    'Campaign userCap=10',
    create.json.data?.userCap === USER_CAP,
    `userCap=${create.json.data?.userCap}`,
  )
  assert(
    'Campaign winRate=30%',
    create.json.data?.winRatePercent === WIN_RATE,
    `winRate=${create.json.data?.winRatePercent}`,
  )
  assert(
    'Campaign has initial PIN on create',
    Boolean(create.json.data?.pin && /^\d{3}$/.test(create.json.data.pin)),
    `pin=${create.json.data?.pin}`,
  )

  const probe = await signupCustomer(0)
  await runPinDeepTests(vendorToken, campaignId, probe)
  await runTenUserScenario(vendorToken, campaignId)

  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length

  console.log(`\n${'─'.repeat(56)}`)
  console.log(`Results: ${passed} passed, ${failed} failed (${results.length} total)`)

  if (failed > 0) {
    console.log('\nFailed:')
    results.filter(r => !r.passed).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`))
    process.exit(1)
  }

  console.log('\n✅ E2E scenario complete — campaign, PIN logic, 10 users, win % verified.\n')
  process.exit(0)
}

main().catch(err => {
  console.error('\nFatal:', err)
  process.exit(1)
})
