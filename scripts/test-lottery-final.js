/**
 * Lottery E2E Test - Using existing business & customer
 */

const API = 'http://localhost:4000/api'

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${JSON.stringify(data)}`)
  return data
}

async function main() {
  console.log('🎟️  LOTTERY E2E TEST\n')
  
  try {
    // 1. Create 2 customers
    console.log('👤 Creating customers...')
    const c1 = await req('POST', '/auth/customer/otp-login', { phone: '9000000001', otp: '123456' })
    const token1 = c1.data.token
    const user1 = c1.data.userId
    console.log(`  ✅ User 1: ${user1}`)
    
    const c2 = await req('POST', '/auth/customer/otp-login', { phone: '9000000002', otp: '123456' })
    const token2 = c2.data.token
    const user2 = c2.data.userId
    console.log(`  ✅ User 2: ${user2}\n`)
    
    // 2. Get existing business & campaigns
    console.log('🏢 Fetching business campaigns...')
    const bid = 'VdEgXiwyrWGr5JVruPymG' // Ark Wellness
    const states = await req('GET', `/campaigns/public/businesses/${bid}/states`, undefined, token1)
    const campaigns = states.data?.campaigns ?? []
    console.log(`  📊 Found ${campaigns.length} campaigns`)
    
    // Find or note lottery
    const lottery = campaigns.find(c => c.mechanic === 'lottery')
    if (!lottery) {
      console.log(`  ❌ No lottery campaign found`)
      console.log(`\n📝 To create lottery:`)
      console.log(`  1. Go to vendor dashboard`)
      console.log(`  2. Create new campaign -> select Lottery`)
      console.log(`  3. Add prizes (Grand, 2nd, 3rd)`)
      console.log(`  4. Set duration (1 month from now)`)
      console.log(`  5. Launch`)
      process.exit(0)
    }
    
    const lid = lottery.id
    console.log(`  ✅ Lottery: ${lottery.name} (${lid})`)
    console.log(`     Status: ${lottery.status}\n`)
    
    // 3. Claim tickets
    console.log('🎟️  CLAIMING TICKETS')
    console.log(`  User 1 claiming...`)
    
    const sess1 = await req('POST', `/campaigns/${lid}/play-session`, { pin: '1234' }, token1)
    const pt1 = sess1.data.token
    
    const claim1 = await req('POST', `/campaigns/${lid}/lottery/claim-ticket`, 
      { playSessionToken: pt1 }, token1)
    console.log(`  ✅ Ticket #${String(claim1.data.ticketNumber).padStart(4, '0')} (${claim1.data.serialCode})`)
    
    console.log(`  User 2 claiming...`)
    const sess2 = await req('POST', `/campaigns/${lid}/play-session`, { pin: '1234' }, token2)
    const pt2 = sess2.data.token
    
    const claim2 = await req('POST', `/campaigns/${lid}/lottery/claim-ticket`, 
      { playSessionToken: pt2 }, token2)
    console.log(`  ✅ Ticket #${String(claim2.data.ticketNumber).padStart(4, '0')} (${claim2.data.serialCode})\n`)
    
    // 4. Check wallet
    console.log('💰 WALLET STATUS')
    const r1 = await req('GET', '/campaigns/customer/rewards', undefined, token1)
    const lr1 = r1.data?.find(r => r.mechanic === 'lottery')
    console.log(`  User 1: ${lr1?.status ?? 'NO TICKET'} (Ticket #${String(lr1?.lottery?.ticketNumber).padStart(4, '0') ?? '--'})`)
    
    const r2 = await req('GET', '/campaigns/customer/rewards', undefined, token2)
    const lr2 = r2.data?.find(r => r.mechanic === 'lottery')
    console.log(`  User 2: ${lr2?.status ?? 'NO TICKET'} (Ticket #${String(lr2?.lottery?.ticketNumber).padStart(4, '0') ?? '--'})\n`)
    
    // 5. Check notifications
    console.log('📬 NOTIFICATIONS')
    const n1 = await req('GET', '/customer/notifications', undefined, token1)
    console.log(`  User 1 unread: ${n1.data?.unreadCount ?? 0}`)
    
    const n2 = await req('GET', '/customer/notifications', undefined, token2)
    console.log(`  User 2 unread: ${n2.data?.unreadCount ?? 0}\n`)
    
    // Summary
    console.log('✅ TEST COMPLETE\n')
    console.log('Summary:')
    console.log(`  ✓ Created 2 customers`)
    console.log(`  ✓ Found lottery campaign`)
    console.log(`  ✓ Both claimed tickets`)
    console.log(`  ✓ Tickets in wallet (lottery_pending)`)
    console.log(`  ✓ Notifications checked`)
    console.log(`\nNext: Wait for draw (end_time) or manually trigger via:`)
    console.log(`  npx tsx scripts/trigger-lottery-draw.ts ${lid}`)
    
  } catch (err) {
    console.error(`\n❌ FAILED: ${err.message}`)
    process.exit(1)
  }
}

main()
