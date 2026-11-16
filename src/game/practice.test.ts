import { describe, expect, it } from 'vitest'
import { act, advance, botAction, newGame, pileInfo, standings, turnSeat, type PracticeGame, type PracticeOpts } from './practice'
import { MAX_HANDS, START_CHIPS } from './rules'

/** 재현 가능한 난수 (mulberry32) */
function seeded(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 모든 좌석을 컴퓨터가 두어 매치 끝까지 진행하고, 판마다 점검 함수를 부른다 */
function playOut(opts: PracticeOpts, seed: number, check?: (g: PracticeGame) => void) {
  const rng = seeded(seed)
  let g = newGame(opts, rng)
  const hands: PracticeGame[] = []
  for (let guard = 0; guard < 2000; guard++) {
    check?.(g)
    if (g.status === 'over') return { g, hands }
    if (g.status === 'finished') {
      hands.push(g)
      g = advance(g, rng)
      continue
    }
    const seat = turnSeat(g)!
    const next = act(g, seat, botAction(g, seat, rng))
    if (!next) throw new Error(`컴퓨터가 불가능한 행동을 했어요 (seed ${seed}, seat ${seat})`)
    g = next
  }
  throw new Error('끝나지 않는 게임')
}

const total = (g: PracticeGame) => {
  // 판 진행 중이면 hand.seats[].chips + committed(+이월), 끝났으면 chips + 이월
  if (g.status === 'betting' && g.hand) return g.hand.seats.reduce((a, s) => a + s.chips + s.committed, 0) + g.hand.carryIn
  return g.chips.reduce((a, b) => a + b, 0) + g.carry
}

describe('연습 게임', () => {
  const combos: PracticeOpts[] = []
  for (const mode of ['A', 'B'] as const) for (const bots of [1, 2, 3, 4]) for (const hard of [false, true]) combos.push({ mode, bots, hard })

  it.each(combos)('끝까지 진행되고 칩 총량이 보존된다 (%o)', (opts) => {
    for (let seed = 1; seed <= 12; seed++) {
      const n = opts.bots + 1
      const { g, hands } = playOut(opts, seed, (x) => expect(total(x)).toBe(START_CHIPS * n))
      expect(g.status).toBe('over')
      expect(g.handNo).toBeLessThanOrEqual(MAX_HANDS)
      expect(hands.length).toBeGreaterThan(0)
      expect(standings(g).filter((s) => s.isWinner).length).toBeGreaterThan(0)
    }
  })

  it('컴퓨터는 규칙에 맞게만 행동한다 (모든 행동이 받아들여진다 — playOut 이 예외 없이 끝남)', () => {
    for (let seed = 100; seed < 130; seed++) playOut({ mode: seed % 2 ? 'A' : 'B', bots: 1 + (seed % 4), hard: seed % 3 === 0 }, seed)
  })

  it('일반 모드: 각 판 카드는 1~10 두 벌 안에서 나온다', () => {
    const { hands } = playOut({ mode: 'A', bots: 4, hard: false }, 7)
    for (const h of hands) {
      const all = h.cards.flatMap((c) => (c ? [...c] : []))
      for (let v = 1; v <= 10; v++) expect(all.filter((x) => x === v).length).toBeLessThanOrEqual(2)
    }
  })

  it('고난이도: 덱을 이어 쓰고(남은 장수 감소) 예고 카드 뒤에 셔플한다', () => {
    const rng = seeded(3)
    let g = newGame({ mode: 'A', bots: 1, hard: true }, rng) // 2명 → 20장
    expect(pileInfo(g)).toMatchObject({ hard: true, total: 20, remaining: 16, shuffle_no: 1, fresh: true, marker_out: false })
    const play = () => {
      while (g.status === 'betting') {
        const seat = turnSeat(g)!
        g = act(g, seat, { type: g.hand!.level > g.hand!.seats[seat].committed ? 'die' : 'check' })!
      }
    }
    const seen: number[] = [...g.cards.flatMap((c) => [...c!])]
    for (const remaining of [12, 8, 4]) {
      play()
      g = advance(g, rng)
      expect(pileInfo(g)).toMatchObject({ remaining, shuffle_no: 1, fresh: false })
      seen.push(...g.cards.flatMap((c) => [...c!]))
    }
    play()
    g = advance(g, rng) // 5판: 예고 카드가 나온다
    seen.push(...g.cards.flatMap((c) => [...c!]))
    expect(pileInfo(g)).toMatchObject({ remaining: 0, marker_out: true, shuffle_no: 1 })
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10])
    play()
    g = advance(g, rng) // 6판: 새로 섞음
    expect(pileInfo(g)).toMatchObject({ remaining: 16, shuffle_no: 2, fresh: true, marker_out: false })
  })

  it('고난이도 4~5명은 30장(1~10 세 벌)', () => {
    for (const bots of [3, 4]) {
      const g = newGame({ mode: 'B', bots, hard: true }, seeded(5))
      expect(pileInfo(g)).toMatchObject({ total: 30 })
    }
  })

  it('판 번호 앤티 같은 커지는 판돈이 없다: 판돈은 인원 × 1칩에서 시작', () => {
    const rng = seeded(11)
    let g = newGame({ mode: 'A', bots: 2, hard: false }, rng)
    while (g.status === 'betting') g = act(g, turnSeat(g)!, { type: g.hand!.level > g.hand!.seats[turnSeat(g)!].committed ? 'die' : 'check' })!
    g = advance(g, rng)
    expect(g.handNo).toBe(2)
    expect(g.hand!.seats.reduce((a, s) => a + s.committed, 0)).toBe(3)
  })
})
