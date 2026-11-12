import { describe, expect, it } from 'vitest'
import {
  applyAction, buildDeck, compareHands, compareRank, deal, evaluate, legalActions, leadSeat, matchOutcome,
  matchProfit, maxRaise, settleHand, shuffle, splitPot, startHand, timeoutAction, toCall,
  type BettingState, type Cards,
} from './rules'

const st = (p: Partial<BettingState> = {}): BettingState => ({
  stacks: [19, 19], committed: [1, 1], pot: 2, turn: 0, raiseCount: 0, checks: 0, ...p,
})

describe('족보 판정', () => {
  it('페어와 합 분류', () => {
    expect(evaluate([3, 3])).toEqual({ category: 'pair', value: 3 })
    expect(evaluate([3, 9])).toEqual({ category: 'sum', value: 12 })
  })
  it('페어 > 합 (가장 낮은 페어도 가장 높은 합을 이긴다)', () => {
    expect(compareHands([1, 1], [10, 9])).toBe(1)
    expect(compareHands([10, 9], [1, 1])).toBe(-1)
  })
  it('페어끼리는 숫자가 큰 쪽', () => {
    expect(compareHands([7, 7], [4, 4])).toBe(1)
    expect(compareHands([4, 4], [7, 7])).toBe(-1)
  })
  it('합이 큰 쪽이 승리, 구성이 달라도 합이 같으면 무승부', () => {
    expect(compareHands([10, 5], [6, 8])).toBe(1)
    expect(compareHands([10, 5], [7, 8])).toBe(0)
    expect(compareHands([6, 6], [6, 6])).toBe(0)
  })
  it('교환 법칙: compare(a,b) = -compare(b,a) (모든 조합)', () => {
    const all: Cards[] = []
    for (let a = 1; a <= 10; a++) for (let b = a; b <= 10; b++) all.push([a, b])
    for (const x of all) for (const y of all) expect(compareHands(x, y)).toBe(-compareHands(y, x) || 0)
  })
})

describe('덱', () => {
  it('1~10 두 벌 20장, 섞어도 구성 유지', () => {
    const d = buildDeck()
    expect(d).toHaveLength(20)
    for (let n = 1; n <= 10; n++) expect(d.filter((x) => x === n)).toHaveLength(2)
    expect([...shuffle(d)].sort((a, b) => a - b)).toEqual([...d].sort((a, b) => a - b))
  })
  it('2장씩 배분', () => {
    const { cards, rest } = deal([1, 2, 3, 4, 5])
    expect(cards).toEqual([[1, 2], [3, 4]])
    expect(rest).toEqual([5])
  })
})

describe('판돈 분배 (무승부 이월 포함)', () => {
  it('승자가 전부 가져간다', () => {
    expect(splitPot(8, 0)).toEqual({ payout: [8, 0], carry: 0 })
    expect(splitPot(8, 1)).toEqual({ payout: [0, 8], carry: 0 })
  })
  it('무승부: 짝수 판돈은 반반', () => {
    expect(splitPot(8, 'tie')).toEqual({ payout: [4, 4], carry: 0 })
  })
  it('무승부: 홀수 판돈의 남는 1칩은 다음 판으로 이월', () => {
    expect(splitPot(7, 'tie')).toEqual({ payout: [3, 3], carry: 1 })
  })
  it('settleHand 는 칩 총량을 보존한다 (이월분 포함)', () => {
    for (const w of [0, 1, 'tie'] as const) {
      const r = settleHand([10, 12], 7, w)
      expect(r.stacks[0] + r.stacks[1] + r.carry).toBe(10 + 12 + 7)
    }
  })
  it('이월된 칩은 다음 판 판돈에 합쳐진다', () => {
    const { state } = startHand([10, 10], 1, 0)
    expect(state.pot).toBe(3)
    expect(state.stacks).toEqual([9, 9])
  })
})

describe('판 시작', () => {
  it('기본 판돈 1칩씩, 선 플레이어부터', () => {
    const { state, immediateShowdown } = startHand([20, 20], 0, 1)
    expect(state).toMatchObject({ stacks: [19, 19], committed: [1, 1], pot: 2, turn: 1 })
    expect(immediateShowdown).toBe(false)
  })
  it('기본 판돈으로 칩이 0이 되면 베팅 없이 쇼다운', () => {
    expect(startHand([1, 20], 0, 0).immediateShowdown).toBe(true)
  })
  it('선은 판마다 교대', () => {
    expect([1, 2, 3, 4, 5].map(leadSeat)).toEqual([0, 1, 0, 1, 0])
  })
})

describe('베팅 검증', () => {
  describe('차례', () => {
    it('내 차례가 아니면 거부', () => {
      expect(applyAction(st({ turn: 0 }), 1, { type: 'check' })).toEqual({ ok: false, error: 'NOT_YOUR_TURN' })
    })
    it('행동 후 차례가 넘어간다', () => {
      const r = applyAction(st(), 0, { type: 'check' })
      expect(r.ok && r.state.turn).toBe(1)
    })
  })

  describe('체크', () => {
    it('올린 금액이 있으면 체크 불가', () => {
      const s = st({ committed: [1, 3], pot: 4, stacks: [19, 17] })
      expect(applyAction(s, 0, { type: 'check' })).toEqual({ ok: false, error: 'CANNOT_CHECK' })
    })
    it('둘 다 체크하면 쇼다운', () => {
      const a = applyAction(st(), 0, { type: 'check' })
      expect(a.ok && a.end).toBeNull()
      if (!a.ok) throw new Error()
      const b = applyAction(a.state, 1, { type: 'check' })
      expect(b.ok && b.end).toEqual({ type: 'showdown' })
    })
    it('체크 후 상대가 베팅하면 다시 체크 카운트가 리셋된다', () => {
      const a = applyAction(st(), 0, { type: 'check' })
      if (!a.ok) throw new Error()
      const b = applyAction(a.state, 1, { type: 'bet', amount: 2 })
      expect(b.ok && b.state.checks).toBe(0)
    })
  })

  describe('베팅/레이즈 금액', () => {
    it('1~3칩만 가능', () => {
      for (const amount of [0, 4, -1, 1.5]) {
        expect(applyAction(st(), 0, { type: 'bet', amount })).toEqual({ ok: false, error: 'BAD_AMOUNT' })
      }
      for (const amount of [1, 2, 3]) expect(applyAction(st(), 0, { type: 'bet', amount }).ok).toBe(true)
    })
    it('올린 금액이 없으면 bet, 있으면 raise 만 허용', () => {
      expect(applyAction(st(), 0, { type: 'raise', amount: 1 })).toEqual({ ok: false, error: 'WRONG_ACTION' })
      const s = st({ committed: [1, 3], pot: 4, stacks: [19, 17] })
      expect(applyAction(s, 0, { type: 'bet', amount: 1 })).toEqual({ ok: false, error: 'WRONG_ACTION' })
    })
    it('베팅하면 칩과 판돈이 갱신된다', () => {
      const r = applyAction(st(), 0, { type: 'bet', amount: 3 })
      if (!r.ok) throw new Error()
      expect(r.state).toMatchObject({ stacks: [16, 19], committed: [4, 1], pot: 5, turn: 1, raiseCount: 1 })
    })
    it('레이즈는 콜 금액 + 올림 금액을 낸다', () => {
      const a = applyAction(st(), 0, { type: 'bet', amount: 2 })
      if (!a.ok) throw new Error()
      expect(toCall(a.state)).toBe(2)
      const b = applyAction(a.state, 1, { type: 'raise', amount: 3 })
      if (!b.ok) throw new Error()
      expect(b.state).toMatchObject({ stacks: [17, 14], committed: [3, 6], pot: 9, raiseCount: 2 })
      expect(toCall(b.state)).toBe(3)
    })
    it('가진 칩보다 많이 걸 수 없다', () => {
      const s = st({ stacks: [2, 19] })
      expect(applyAction(s, 0, { type: 'bet', amount: 3 })).toEqual({ ok: false, error: 'BAD_AMOUNT' })
      expect(applyAction(s, 0, { type: 'bet', amount: 2 }).ok).toBe(true)
    })
    it('상대가 콜할 수 없는 금액도 걸 수 없다', () => {
      expect(maxRaise(st({ stacks: [19, 1] }))).toBe(1)
      expect(applyAction(st({ stacks: [19, 1] }), 0, { type: 'bet', amount: 2 })).toEqual({ ok: false, error: 'BAD_AMOUNT' })
    })
  })

  describe('레이즈 횟수 제한', () => {
    it('한 판에 베팅/레이즈는 총 3회, 4번째는 거부', () => {
      let s = st()
      let seat: 0 | 1 = 0
      for (let i = 0; i < 3; i++) {
        const r = applyAction(s, seat, i === 0 ? { type: 'bet', amount: 1 } : { type: 'raise', amount: 1 })
        if (!r.ok) throw new Error(r.error)
        s = r.state
        seat = seat === 0 ? 1 : 0
      }
      expect(s.raiseCount).toBe(3)
      expect(legalActions(s).canRaise).toBe(false)
      expect(applyAction(s, seat, { type: 'raise', amount: 1 })).toEqual({ ok: false, error: 'RAISE_LIMIT' })
      // 콜/다이는 여전히 가능
      expect(applyAction(s, seat, { type: 'call' }).ok).toBe(true)
      expect(applyAction(s, seat, { type: 'die' }).ok).toBe(true)
    })
  })

  describe('콜', () => {
    it('맞출 금액이 없으면 콜 불가', () => {
      expect(applyAction(st(), 0, { type: 'call' })).toEqual({ ok: false, error: 'NOTHING_TO_CALL' })
    })
    it('콜하면 쇼다운', () => {
      const a = applyAction(st(), 0, { type: 'bet', amount: 2 })
      if (!a.ok) throw new Error()
      const b = applyAction(a.state, 1, { type: 'call' })
      if (!b.ok) throw new Error()
      expect(b.end).toEqual({ type: 'showdown' })
      expect(b.state).toMatchObject({ stacks: [17, 17], committed: [3, 3], pot: 6 })
    })
  })

  describe('다이', () => {
    it('다이한 쪽이 패배 (카드 공개 없는 종료)', () => {
      const r = applyAction(st(), 0, { type: 'die' })
      expect(r.ok && r.end).toEqual({ type: 'fold', loser: 0 })
    })
  })

  describe('올인', () => {
    it('남은 칩 전부를 베팅할 수 있다', () => {
      const s = st({ stacks: [2, 19] })
      const r = applyAction(s, 0, { type: 'bet', amount: 2 })
      if (!r.ok) throw new Error()
      expect(r.state.stacks[0]).toBe(0)
      // 올인 이후 상대는 레이즈 불가 (내 칩 0)
      expect(maxRaise(r.state)).toBe(0)
      const c = applyAction(r.state, 1, { type: 'call' })
      expect(c.ok && c.end).toEqual({ type: 'showdown' })
    })
    it('칩이 모자라면 남은 칩 전부로 콜하고, 상대의 초과분은 돌려준다', () => {
      // 상대가 5칩을 올려둔 상태에서 내 칩은 2뿐인 경우
      const s = st({ stacks: [2, 14], committed: [1, 6], pot: 7, turn: 0 })
      expect(legalActions(s).callAmount).toBe(2)
      const r = applyAction(s, 0, { type: 'call' })
      if (!r.ok) throw new Error()
      expect(r.end).toEqual({ type: 'showdown' })
      expect(r.state.stacks).toEqual([0, 17]) // 14 + 3 환급
      expect(r.state.committed).toEqual([3, 3])
      expect(r.state.pot).toBe(6)
      // 칩 총량 보존
      expect(r.state.stacks[0] + r.state.stacks[1] + r.state.pot).toBe(2 + 14 + 7)
    })
  })

  describe('시간 초과 자동 행동', () => {
    it('체크 가능하면 체크, 아니면 다이', () => {
      expect(timeoutAction(st())).toEqual({ type: 'check' })
      expect(timeoutAction(st({ committed: [1, 2], stacks: [19, 18], pot: 3 }))).toEqual({ type: 'die' })
    })
  })

  it('무작위 플레이 1000판: 칩 총량 보존, 항상 종료', () => {
    let seed = 12345
    const rng = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
    for (let n = 0; n < 1000; n++) {
      const stacks: [number, number] = [1 + Math.floor(rng() * 20), 1 + Math.floor(rng() * 20)]
      const total = stacks[0] + stacks[1]
      const { state: s0, immediateShowdown } = startHand(stacks, 0, rng() < 0.5 ? 0 : 1)
      let s = s0
      let ended = immediateShowdown
      for (let i = 0; i < 30 && !ended; i++) {
        const la = legalActions(s)
        const opts: any[] = [{ type: 'die' }]
        if (la.canCheck) opts.push({ type: 'check' })
        if (la.canCall) opts.push({ type: 'call' })
        if (la.canRaise) opts.push({ type: la.raiseKind, amount: 1 + Math.floor(rng() * la.raiseMax) })
        const r = applyAction(s, s.turn, opts[Math.floor(rng() * opts.length)])
        if (!r.ok) throw new Error(r.error)
        s = r.state
        expect(s.stacks[0]).toBeGreaterThanOrEqual(0)
        expect(s.stacks[1]).toBeGreaterThanOrEqual(0)
        expect(s.stacks[0] + s.stacks[1] + s.pot).toBe(total)
        if (r.end) ended = true
      }
      expect(ended).toBe(true)
    }
  })
})

describe('매치 종료/수익', () => {
  it('칩이 0이 되면 즉시 종료', () => {
    expect(matchOutcome([0, 40], 2)).toEqual({ finished: true, reason: 'bust', winner: 1 })
  })
  it('5판을 마치면 종료, 칩 많은 쪽 승리', () => {
    expect(matchOutcome([25, 15], 5)).toEqual({ finished: true, reason: 'complete', winner: 0 })
    expect(matchOutcome([20, 20], 5)).toEqual({ finished: true, reason: 'complete', winner: null })
  })
  it('5판 미만이고 칩이 남아 있으면 계속', () => {
    expect(matchOutcome([30, 10], 4).finished).toBe(false)
  })
  it('수익 = 최종 칩 - 20, 기권자는 이득을 챙길 수 없다', () => {
    expect(matchProfit(27)).toBe(7)
    expect(matchProfit(8)).toBe(-12)
    expect(matchProfit(30, true)).toBe(0)
    expect(matchProfit(8, true)).toBe(-12)
  })
})

describe('랭킹 정렬', () => {
  it('누적 수익 → 승리 매치 수 → 먼저 참여한 순', () => {
    const rows = [
      { n: 'c', total_profit: 5, matches_won: 1, joined_at: '2026-01-01T00:00:03Z' },
      { n: 'a', total_profit: 5, matches_won: 2, joined_at: '2026-01-01T00:00:02Z' },
      { n: 'b', total_profit: 5, matches_won: 2, joined_at: '2026-01-01T00:00:01Z' },
      { n: 'd', total_profit: 9, matches_won: 0, joined_at: '2026-01-01T00:00:09Z' },
    ]
    expect(rows.sort(compareRank).map((r) => r.n)).toEqual(['d', 'b', 'a', 'c'])
  })
})
