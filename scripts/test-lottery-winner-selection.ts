import assert from 'node:assert/strict'
import { selectLotteryWinners } from '../src/services/lottery-service.js'

function ticket(id: string, customerId: string) {
  return { id, customer_id: customerId, ticket_number: Number(id.replace(/\D/g, '') || 1) }
}

function prize(id: string, sort: number) {
  return { id, name: `Prize ${id}`, sort_order: sort }
}

// Deterministic RNG from a sequence
function seqRandom(values: number[]) {
  let i = 0
  return () => {
    const v = values[i % values.length]!
    i += 1
    return v
  }
}

// Customer A has 3 tickets, B has 1 — first pick always lands in A's range when random < 0.75
{
  const tickets = [
    ticket('t1', 'A'),
    ticket('t2', 'A'),
    ticket('t3', 'A'),
    ticket('t4', 'B'),
  ]
  const prizes = [prize('jackpot', 0), prize('second', 1)]
  const winners = selectLotteryWinners(tickets, prizes, seqRandom([0.1, 0.0]))
  assert.equal(winners.length, 2)
  assert.equal(winners[0]!.ticket.customer_id, 'A')
  // After A wins jackpot, A's remaining tickets are excluded — B must win 2nd
  assert.equal(winners[1]!.ticket.customer_id, 'B')
}

// More tickets → higher empirical win rate for jackpot
{
  const tickets = [
    ...Array.from({ length: 9 }, (_, i) => ticket(`a${i}`, 'heavy')),
    ticket('b0', 'light'),
  ]
  let heavyWins = 0
  const trials = 2000
  for (let i = 0; i < trials; i++) {
    const winners = selectLotteryWinners(tickets, [prize('j', 0)])
    if (winners[0]?.ticket.customer_id === 'heavy') heavyWins++
  }
  const rate = heavyWins / trials
  assert.ok(rate > 0.8, `expected heavy customer ~90% wins, got ${rate}`)
  assert.ok(rate < 0.98, `expected some light wins, got ${rate}`)
}

console.log('selectLotteryWinners tests passed')
