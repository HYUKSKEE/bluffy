import { describe, expect, it } from 'vitest'
import {
  anteFor, applyAction, raiseAmounts, buildDeck, compareHands, compareRank, deal, evaluate, forfeitSeat, leadSeat, legalActions,
  matchOutcome, matchProfit, matchWinners, potOf, settleFold, settleShowdown, shuffle, startHand, timeoutAction,
  toCall, type Action, type Cards, type HandEnd, type HandState,
} from './rules'

/** 테스트 도우미: 연속 행동을 적용하고 마지막 결과를 돌려준다 */
function play(s: HandState, steps: [number, Action][]) {
  let state = s
  let end: HandEnd | null = null
  for (const [seat, a] of steps) {
    const r = applyAction(state, seat, a)
    if (!r.ok) throw new Error(`seat ${seat} ${a.type}: ${r.error}`)
    state = r.state
    end = r.end
  }
  return { state, end }
}
const chipsOf = (s: HandState) => s.seats.map((x) => x.chips)

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

describe('덱 / 배분', () => {
  it('1~10 두 벌 20장, 섞어도 구성 유지', () => {
    const d = buildDeck()
    expect(d).toHaveLength(20)
    for (let n = 1; n <= 10; n++) expect(d.filter((x) => x === n)).toHaveLength(2)
    expect([...shuffle(d)].sort((a, b) => a - b)).toEqual([...d].sort((a, b) => a - b))
  })
  it('5명에게 2장씩 배분해도 덱이 충분하다', () => {
    const { cards, rest } = deal(buildDeck(), 5)
    expect(cards).toHaveLength(5)
    expect(rest).toHaveLength(10)
    expect(cards[2]).toEqual([5, 6])
  })
})

describe('앤티 = 판 번호', () => {
  it('판 번호만큼 앤티를 낸다', () => {
    const { state } = startHand([100, 100, 100], 0, 0, 7)
    expect(chipsOf(state)).toEqual([93, 93, 93])
    expect(potOf(state)).toBe(21)
    expect(state.level).toBe(7)
  })
  it('칩이 모자라면 가진 칩 전부를 앤티로 내고 올인', () => {
    const { state } = startHand([100, 4, 100], 0, 0, 6)
    expect(chipsOf(state)).toEqual([94, 0, 94])
    expect(state.seats[1].committed).toBe(4)
    expect(state.seats[1].pending).toBe(false)
    expect(state.level).toBe(6)
  })
  it('계속 다이만 하면 10판 동안 55칩을 잃는다 (숨어서 이기기 방지)', () => {
    let total = 0
    for (let n = 1; n <= 10; n++) total += anteFor(n)
    expect(total).toBe(55)
  })
})

describe('판 시작', () => {
  it('칩이 있는 모든 사람이 기본 판돈 1칩을 내고 선부터 행동', () => {
    const { state, end } = startHand([100, 100, 100], 0, 1)
    expect(end).toBeNull()
    expect(chipsOf(state)).toEqual([99, 99, 99])
    expect(potOf(state)).toBe(3)
    expect(state.turn).toBe(1)
    expect(state.level).toBe(1)
  })
  it('칩이 없는 탈락자는 카드를 받지 않고 판돈도 내지 않는다', () => {
    const { state } = startHand([50, 0, 50, 0, 50], 0, 0)
    expect(state.seats.map((x) => x.inHand)).toEqual([true, false, true, false, true])
    expect(potOf(state)).toBe(3)
  })
  it('선이 탈락자 자리면 다음 생존자부터 행동', () => {
    const { state } = startHand([50, 0, 50], 0, 1)
    expect(state.turn).toBe(2)
  })
  it('이월된 칩은 판돈에 합쳐진다', () => {
    expect(potOf(startHand([10, 10], 1, 0).state)).toBe(3)
  })
  it('기본 판돈으로 칩이 0이 되어 행동할 사람이 1명 이하면 베팅 없이 쇼다운', () => {
    const { state, end } = startHand([1, 100], 0, 0)
    expect(end).toEqual({ type: 'showdown' })
    expect(state.turn).toBeNull()
    expect(startHand([1, 1, 100], 0, 2).end).toEqual({ type: 'showdown' })
  })
  it('올인한 사람이 있어도 행동할 사람이 2명 이상이면 베팅한다', () => {
    const { state, end } = startHand([1, 100, 100], 0, 0)
    expect(end).toBeNull()
    expect(state.turn).toBe(1) // 칩이 0인 0번 좌석은 건너뜀
  })
  it('선은 판마다 한 칸씩 이동 (칩이 남은 사람 기준)', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => leadSeat(n, [10, 10, 10]))).toEqual([0, 1, 2, 0, 1, 2])
    expect([1, 2, 3].map((n) => leadSeat(n, [10, 0, 10]))).toEqual([0, 2, 0])
  })
})

describe('베팅 검증 — 차례', () => {
  it('내 차례가 아니면 거부, 행동 후 시계방향으로 차례가 넘어간다', () => {
    const { state } = startHand([100, 100, 100], 0, 0)
    expect(applyAction(state, 1, { type: 'check' })).toEqual({ ok: false, error: 'NOT_YOUR_TURN' })
    const r = applyAction(state, 0, { type: 'check' })
    expect(r.ok && r.state.turn).toBe(1)
    const r2 = r.ok && applyAction(r.state, 1, { type: 'check' })
    expect(r2 && r2.ok && r2.state.turn).toBe(2)
  })
  it('다이한 사람은 이후 차례에서 건너뛴다', () => {
    const { state } = startHand([100, 100, 100], 0, 0)
    const { state: s } = play(state, [[0, { type: 'bet', amount: 1 }], [1, { type: 'die' }]])
    expect(s.turn).toBe(2)
    const r = applyAction(s, 2, { type: 'call' })
    expect(r.ok && r.end).toEqual({ type: 'showdown' }) // 0 은 아직 pending 아님, 2 가 콜하면 종료
  })
})

describe('베팅 검증 — 체크/콜/금액/횟수', () => {
  const base = () => startHand([100, 100, 100], 0, 0).state

  it('모두 체크하면 쇼다운 (둘이 아니라 전원이 체크해야 한다)', () => {
    const { end, state } = play(base(), [[0, { type: 'check' }], [1, { type: 'check' }]])
    expect(end).toBeNull()
    expect(state.turn).toBe(2)
    expect(play(state, [[2, { type: 'check' }]]).end).toEqual({ type: 'showdown' })
  })
  it('올린 금액이 있으면 체크 불가 / 없으면 콜 불가', () => {
    expect(applyAction(base(), 0, { type: 'call' })).toEqual({ ok: false, error: 'NOTHING_TO_CALL' })
    const { state } = play(base(), [[0, { type: 'bet', amount: 2 }]])
    expect(applyAction(state, 1, { type: 'check' })).toEqual({ ok: false, error: 'CANNOT_CHECK' })
  })
  it('금액은 1~3칩, bet/raise 종류도 맞아야 한다', () => {
    for (const amount of [0, 4, -1, 1.5]) {
      expect(applyAction(base(), 0, { type: 'bet', amount })).toEqual({ ok: false, error: 'BAD_AMOUNT' })
    }
    expect(applyAction(base(), 0, { type: 'raise', amount: 1 })).toEqual({ ok: false, error: 'WRONG_ACTION' })
    const { state } = play(base(), [[0, { type: 'bet', amount: 1 }]])
    expect(applyAction(state, 1, { type: 'bet', amount: 1 })).toEqual({ ok: false, error: 'WRONG_ACTION' })
  })
  it('레이즈는 콜 금액 + 올림 금액을 낸다', () => {
    const { state } = play(base(), [[0, { type: 'bet', amount: 2 }], [1, { type: 'raise', amount: 3 }]])
    expect(state.level).toBe(6)
    expect(state.seats[1].committed).toBe(6)
    expect(chipsOf(state)).toEqual([97, 94, 99])
    expect(toCall(state, 0)).toBe(3)
    expect(toCall(state, 2)).toBe(5)
  })
  it('레이즈가 나오면 이미 콜한 사람도 다시 행동해야 한다', () => {
    let s = base()
    ;({ state: s } = play(s, [[0, { type: 'bet', amount: 1 }], [1, { type: 'call' }]]))
    expect(s.turn).toBe(2)
    const r = play(s, [[2, { type: 'raise', amount: 2 }]])
    expect(r.end).toBeNull()
    expect(r.state.turn).toBe(0) // 0 → 1 순서로 다시 돌아온다
    const r2 = play(r.state, [[0, { type: 'call' }]])
    expect(r2.state.turn).toBe(1)
    expect(play(r2.state, [[1, { type: 'call' }]]).end).toEqual({ type: 'showdown' })
  })
  it('베팅/레이즈는 판당 총 3회까지, 이후엔 콜/다이만', () => {
    const { state } = play(base(), [
      [0, { type: 'bet', amount: 1 }], [1, { type: 'raise', amount: 1 }], [2, { type: 'raise', amount: 1 }],
    ])
    expect(state.raiseCount).toBe(3)
    expect(legalActions(state, 0).canRaise).toBe(false)
    expect(applyAction(state, 0, { type: 'raise', amount: 1 })).toEqual({ ok: false, error: 'RAISE_LIMIT' })
    expect(applyAction(state, 0, { type: 'call' }).ok).toBe(true)
    expect(applyAction(state, 0, { type: 'die' }).ok).toBe(true)
  })
  it('가진 칩보다 많이 걸 수 없다', () => {
    const { state } = startHand([3, 100, 100], 0, 0) // 선의 남은 칩 2
    expect(applyAction(state, 0, { type: 'bet', amount: 3 })).toEqual({ ok: false, error: 'BAD_AMOUNT' })
    expect(applyAction(state, 0, { type: 'bet', amount: 2 }).ok).toBe(true)
  })
})

describe('다이 / 올인', () => {
  it('다이하면 남은 한 명이 판돈을 가져간다 (카드 공개 없음)', () => {
    const { state } = startHand([100, 100], 0, 0)
    const r = applyAction(state, 0, { type: 'die' })
    expect(r.ok && r.end).toEqual({ type: 'fold', winner: 1 })
    if (r.ok) expect(settleFold(r.state, 1)).toEqual({ payouts: [0, 2], carry: 0 })
  })
  it('3명 중 두 명이 다이하면 남은 사람이 승리', () => {
    const { state } = startHand([100, 100, 100], 0, 0)
    const { end, state: s } = play(state, [[0, { type: 'bet', amount: 3 }], [1, { type: 'die' }], [2, { type: 'die' }]])
    expect(end).toEqual({ type: 'fold', winner: 0 })
    expect(settleFold(s, 0).payouts).toEqual([potOf(s), 0, 0])
  })
  it('남은 칩 전부를 베팅(올인)할 수 있고, 올인한 사람은 이후 행동하지 않는다', () => {
    const { state } = startHand([3, 100, 100], 0, 0) // 선: 남은 칩 2
    const { state: s } = play(state, [[0, { type: 'bet', amount: 2 }]])
    expect(s.seats[0].chips).toBe(0)
    const r = play(s, [[1, { type: 'call' }], [2, { type: 'call' }]])
    expect(r.end).toEqual({ type: 'showdown' })
  })
  it('칩이 모자라면 남은 칩 전부로 콜(올인)한다', () => {
    // 필요 금액(3)과 남은 칩(3)이 같으면 정확히 올인
    const { state: s } = play(startHand([100, 4, 100], 0, 0).state, [[0, { type: 'bet', amount: 3 }]])
    expect(s.turn).toBe(1)
    const { state: s2 } = play(s, [[1, { type: 'call' }]])
    expect(s2.seats[1].chips).toBe(0)
    // 필요 금액(3)이 남은 칩(2)보다 크면 남은 칩 전부로 콜
    const st = startHand([100, 3, 100], 0, 0).state
    const { state: t } = play(st, [[0, { type: 'bet', amount: 3 }]])
    expect(legalActions(t, 1).callAmount).toBe(2)
    const r = applyAction(t, 1, { type: 'call' })
    expect(r.ok && r.state.seats[1]).toMatchObject({ chips: 0, committed: 3 })
  })
})

describe('판돈 정산 / 사이드 팟 / 무승부 이월', () => {
  const hs = (...c: (Cards | null)[]) => c

  it('승자가 판돈을 독식 (생존자 중 최고 족보)', () => {
    const { state } = startHand([100, 100, 100], 0, 0)
    const { state: s, end } = play(state, [
      [0, { type: 'bet', amount: 3 }], [1, { type: 'call' }], [2, { type: 'call' }],
    ])
    expect(end).toEqual({ type: 'showdown' })
    const r = settleShowdown(s, hs([2, 2], [10, 9], [1, 1]))
    expect(r.payouts).toEqual([12, 0, 0]) // 페어가 합을 이기고, 페어끼리는 큰 숫자 [2,2] > [1,1]
    expect(r.carry).toBe(0)
  })
  it('다이한 사람의 카드는 족보 비교에서 제외된다', () => {
    const { state } = startHand([100, 100, 100], 0, 0)
    const { state: s } = play(state, [[0, { type: 'bet', amount: 2 }], [1, { type: 'die' }], [2, { type: 'call' }]])
    const r = settleShowdown(s, hs([3, 4], [10, 10], [5, 5]))
    // 다이한 1번의 [10,10]은 제외 → 2번 [5,5] 가 이김. 1번이 낸 기본 판돈 1칩도 2번이 가져간다
    expect(r.payouts).toEqual([0, 0, potOf(s)])
  })
  it('무승부면 나누고 남는 칩은 이월된다', () => {
    const { state } = startHand([100, 100, 100], 0, 0)
    const { state: s } = play(state, [[0, { type: 'check' }], [1, { type: 'check' }], [2, { type: 'check' }]])
    // 판돈 3, 두 명이 동점 → 1칩씩, 1칩 이월 (좌석 2는 낮은 족보)
    const r = settleShowdown(s, hs([5, 5], [5, 5], [1, 2]))
    expect(r.payouts).toEqual([1, 1, 0])
    expect(r.carry).toBe(1)
    expect(r.payouts.reduce((a, b) => a + b, 0) + r.carry).toBe(potOf(s))
  })
  it('이월 칩이 포함된 판돈도 보존된다', () => {
    const { state } = startHand([10, 10], 1, 0)
    const { state: s } = play(state, [[0, { type: 'check' }], [1, { type: 'check' }]])
    const r = settleShowdown(s, hs([4, 4], [4, 4]))
    expect(r).toEqual({ payouts: [1, 1], carry: 1 }) // 판돈 3 → 1,1 + 이월 1
  })
  it('사이드 팟: 올인한 사람은 자기가 낸 만큼의 배수까지만 가져간다', () => {
    // 0번은 남은 칩 2로 올인(총 3), 1·2번은 더 건다
    const { state } = startHand([3, 100, 100], 0, 0)
    const { state: s, end } = play(state, [
      [0, { type: 'bet', amount: 2 }], // 0: committed 3
      [1, { type: 'raise', amount: 3 }], // level 6
      [2, { type: 'call' }],
      // 0 은 올인이라 pending 아님 → 1 은 이미 level 도달, 2 도 call → 끝
    ])
    expect(end).toEqual({ type: 'showdown' })
    expect(s.seats.map((x) => x.committed)).toEqual([3, 6, 6])
    // 0번이 최고 족보: 메인 팟(3×3=9)만 가져가고, 남은 사이드 팟(3×2=6)은 1·2번 중 승자
    const r = settleShowdown(s, hs([10, 10], [9, 9], [8, 8]))
    expect(r.payouts).toEqual([9, 6, 0])
    expect(r.payouts.reduce((a, b) => a + b, 0)).toBe(potOf(s))
  })
  it('사이드 팟: 올인한 사람이 지면 메인 팟도 나머지 중 최고 족보가 가져간다', () => {
    const { state } = startHand([3, 100, 100], 0, 0)
    const { state: s } = play(state, [[0, { type: 'bet', amount: 2 }], [1, { type: 'call' }], [2, { type: 'call' }]])
    const r = settleShowdown(s, hs([1, 2], [9, 9], [8, 8]))
    expect(r.payouts).toEqual([0, 9, 0])
  })
  it('칩 총량 보존 (무작위 사이드 팟 조합 500회)', () => {
    let seed = 7
    const rng = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
    for (let t = 0; t < 500; t++) {
      const n = 2 + Math.floor(rng() * 4)
      const chips = Array.from({ length: n }, () => 1 + Math.floor(rng() * 8))
      const carry = rng() < 0.3 ? 1 : 0
      const { state: s0, end } = startHand(chips, carry, 0)
      let s = s0
      let ended = end
      for (let i = 0; i < 60 && !ended && s.turn !== null; i++) {
        const la = legalActions(s, s.turn)
        const opts: Action[] = [{ type: 'die' }]
        if (la.canCheck) opts.push({ type: 'check' })
        if (la.canCall) opts.push({ type: 'call' })
        if (la.canRaise) opts.push({ type: la.raiseKind, amount: 1 + Math.floor(rng() * la.raiseMax) })
        const r = applyAction(s, s.turn, opts[Math.floor(rng() * opts.length)])
        if (!r.ok) throw new Error(r.error)
        s = r.state
        ended = r.end
      }
      expect(ended).not.toBeNull()
      const cards: (Cards | null)[] = s.seats.map(() => [1 + Math.floor(rng() * 10), 1 + Math.floor(rng() * 10)] as Cards)
      const st = ended!.type === 'fold' ? settleFold(s, ended!.winner) : settleShowdown(s, cards)
      const total = chips.reduce((a, b) => a + b, 0) + carry
      const after = s.seats.reduce((a, x, i) => a + x.chips + st.payouts[i], 0) + st.carry
      expect(after).toBe(total)
    }
  })
})

describe('시간 초과 / 기권', () => {
  it('체크 가능하면 체크, 아니면 다이', () => {
    const { state } = startHand([100, 100, 100], 0, 0)
    expect(timeoutAction(state, 0)).toEqual({ type: 'check' })
    const { state: s } = play(state, [[0, { type: 'bet', amount: 1 }]])
    expect(timeoutAction(s, 1)).toEqual({ type: 'die' })
  })
  it('나간 사람은 현재 판에서 다이 처리되고 차례가 넘어간다', () => {
    const { state } = startHand([100, 100, 100], 0, 0)
    const r = forfeitSeat(state, 0)
    expect(r.end).toBeNull()
    expect(r.state.turn).toBe(1)
    const r2 = forfeitSeat(r.state, 1)
    expect(r2.end).toEqual({ type: 'fold', winner: 2 })
  })
})

describe('매치 종료 / 수익', () => {
  it('한 명만 칩이 남으면 즉시 종료(탈락자는 칩 0)', () => {
    expect(matchOutcome([{ chips: 0, left: false }, { chips: 200, left: false }], 3)).toEqual({ finished: true, reason: 'bust' })
    expect(matchOutcome([{ chips: 0, left: false }, { chips: 150, left: false }, { chips: 50, left: false }], 3).finished).toBe(false)
  })
  it('10판을 마치면 종료', () => {
    const seats = [{ chips: 110, left: false }, { chips: 90, left: false }]
    expect(matchOutcome(seats, 9).finished).toBe(false)
    expect(matchOutcome(seats, 10)).toEqual({ finished: true, reason: 'complete' })
  })
  it('나간 사람이 있어 한 명만 남으면 forfeit', () => {
    expect(matchOutcome([{ chips: 50, left: true }, { chips: 150, left: false }], 2)).toEqual({ finished: true, reason: 'forfeit' })
  })
  it('승자는 나가지 않은 사람 중 칩 최다 (동점이면 공동 승자)', () => {
    expect(matchWinners([{ chips: 120, left: false }, { chips: 80, left: false }, { chips: 200, left: true }])).toEqual([true, false, false])
    expect(matchWinners([{ chips: 100, left: false }, { chips: 100, left: false }, { chips: 40, left: false }])).toEqual([true, true, false])
  })
  it('수익 = 최종 칩 − 100, 기권자는 이득을 챙길 수 없다', () => {
    expect(matchProfit(127)).toBe(27)
    expect(matchProfit(58)).toBe(-42)
    expect(matchProfit(130, true)).toBe(0)
    expect(matchProfit(58, true)).toBe(-42)
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

describe('베팅 단위 = 앤티', () => {
  it('5판: 5·10·15칩, 올인이 단위보다 작으면 그 금액만', () => {
    const { state } = startHand([100, 100], 0, 0, 5)
    const l = legalActions(state, 0)
    expect(l).toMatchObject({ unit: 5, raiseMax: 15 })
    expect(raiseAmounts(l)).toEqual([5, 10, 15])
    expect(applyAction(state, 0, { type: 'bet', amount: 4 })).toMatchObject({ ok: false, error: 'BAD_AMOUNT' })
    expect(applyAction(state, 0, { type: 'bet', amount: 16 })).toMatchObject({ ok: false, error: 'BAD_AMOUNT' })
    expect(applyAction(state, 0, { type: 'bet', amount: 10 })).toMatchObject({ ok: true })
    // 앤티 5를 내고 칩이 3 남음 → 3(올인)만 가능
    const short = startHand([8, 100], 0, 0, 5).state
    const ls = legalActions(short, 0)
    expect(raiseAmounts(ls)).toEqual([3])
    expect(applyAction(short, 0, { type: 'bet', amount: 3 })).toMatchObject({ ok: true })
    expect(applyAction(short, 0, { type: 'bet', amount: 2 })).toMatchObject({ ok: false })
  })
  it('1판은 이전과 같다 (1·2·3칩)', () => {
    const l = legalActions(startHand([100, 100], 0, 0, 1).state, 0)
    expect(raiseAmounts(l)).toEqual([1, 2, 3])
  })
})
