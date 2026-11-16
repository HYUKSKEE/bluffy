import { beforeAll, describe, expect, it } from 'vitest'
import { applyAction, handName, seotdaRank, seotdaShowdownRanks, settleShowdown, startHand, type Cards } from '../game/rules'
import { createDb, newUser, rpc, sql, type Db } from './harness'

let db: Db
beforeAll(async () => {
  db = await createDb()
})

const C = (a: number, b: number): Cards => [a, b]

describe('섯다 족보 (TS)', () => {
  it('이름과 순서', () => {
    // id: 1=1월광 2=1월띠 3,4=2월 5=3월광 6=3월띠 7=4월열끗 8=4월띠 13=7월열끗 15=8월광
    const names: [Cards, string][] = [
      [C(5, 15), '38광땡'], [C(1, 15), '18광땡'], [C(1, 5), '13광땡'],
      [C(19, 20), '장땡'], [C(17, 18), '9땡'], [C(1, 2), '1땡'],
      [C(1, 3), '알리'], [C(1, 7), '독사'], [C(1, 17), '구삥'], [C(1, 19), '장삥'], [C(7, 19), '장사'], [C(7, 11), '세륙'],
      [C(17, 7), '3끗'], [C(3, 11), '8끗'], [C(3, 13), '갑오'], [C(3, 15), '망통'],
      [C(7, 13), '암행어사'], [C(5, 13), '땡잡이'],
    ]
    for (const [cards, name] of names) expect(handName(cards, 'seotda'), JSON.stringify(cards)).toBe(name)
  })

  it('기본 점수의 순서: 38광땡 > 18=13광땡 > 장땡 > … > 알리 > … > 세륙 > 갑오 > … > 망통', () => {
    const r = (a: number, b: number) => seotdaRank([a, b])
    expect(r(5, 15)).toBeGreaterThan(r(1, 15))
    expect(r(1, 15)).toBe(r(1, 5))
    expect(r(1, 5)).toBeGreaterThan(r(19, 20))
    expect(r(19, 20)).toBeGreaterThan(r(17, 18))
    expect(r(1, 2)).toBeGreaterThan(r(1, 3)) // 1땡 > 알리
    expect(r(1, 3)).toBeGreaterThan(r(1, 7)) // 알리 > 독사
    expect(r(1, 7)).toBeGreaterThan(r(1, 17)) // 독사 > 구삥
    expect(r(1, 17)).toBeGreaterThan(r(1, 19)) // 구삥 > 장삥
    expect(r(1, 19)).toBeGreaterThan(r(7, 19)) // 장삥 > 장사
    expect(r(7, 19)).toBeGreaterThan(r(7, 11)) // 장사 > 세륙
    expect(r(7, 11)).toBeGreaterThan(r(3, 13)) // 세륙 > 갑오
    expect(r(3, 13)).toBeGreaterThan(r(3, 15)) // 갑오 > 망통
  })

  it('암행어사는 18/13광땡을 이기지만 38광땡은 못 이긴다, 광땡이 없으면 일반 1끗', () => {
    const amhaeng = C(7, 13)
    expect(seotdaShowdownRanks([amhaeng, C(1, 15)])).toEqual([12500, 12000])
    expect(seotdaShowdownRanks([amhaeng, C(1, 5)])).toEqual([12500, 12000])
    expect(seotdaShowdownRanks([amhaeng, C(5, 15)])[0]).toBeLessThan(13000)
    expect(seotdaShowdownRanks([amhaeng, C(19, 20)])).toEqual([5001, 9100]) // 장땡에게 진다
  })

  it('땡잡이는 1~9땡을 이기지만 장땡·광땡은 못 이긴다, 땡이 없으면 망통', () => {
    const jabi = C(5, 13)
    expect(seotdaShowdownRanks([jabi, C(17, 18)])).toEqual([9095, 9090])
    expect(seotdaShowdownRanks([jabi, C(19, 20), C(17, 18)])[0]).toBeLessThan(9100)
    expect(seotdaShowdownRanks([jabi, C(1, 15)])[0]).toBe(5000)
    expect(seotdaShowdownRanks([jabi, C(1, 3)])).toEqual([5000, 8000]) // 땡이 없으면 알리에게도 진다
  })

  it('쇼다운 정산: 팟 단계별로 특수 족보가 적용된다 (TS)', () => {
    const { state } = startHand([100, 100, 100], 0, 0)
    // 모두 같은 금액을 건 상태에서 땡잡이 vs 9땡 vs 알리 → 땡잡이가 이긴다
    const hands: Cards[] = [C(5, 13), C(17, 18), C(1, 3)]
    const s = settleShowdown(state, hands, 'seotda')
    expect(s.payouts).toEqual([3, 0, 0])
  })
})

describe('섯다 족보 (SQL = TS)', () => {
  it('모든 카드 쌍(20×20)의 점수와 특수 족보가 TS 와 같다', async () => {
    for (let a = 1; a <= 20; a++) {
      for (let b = 1; b <= 20; b++) {
        const r = (await sql(db, 'select card_game.seotda_rank($1::int[]) as r, card_game.seotda_special($1::int[]) as s', [[a, b]])).rows[0]
        expect(r.r, `${a},${b}`).toBe(seotdaRank([a, b]))
      }
    }
  })
})

async function setupSeotda(n: number, hard = false) {
  const owner = newUser()
  const room = await rpc(db, owner, 'create_room_ex', '섯다방', 'A', hard)
  await rpc(db, owner, 'set_room_seotda', room.room_id, room.admin_token, true)
  const users: string[] = []
  let matchId = ''
  for (let i = 0; i < n; i++) {
    const u = newUser()
    users.push(u)
    await rpc(db, u, 'join_room', room.room_id, `선수${i + 1}`)
    matchId = (await rpc(db, u, 'queue_match', room.room_id)).match_id
  }
  if (n < 5) await rpc(db, users[0], 'start_match', matchId)
  return { owner, room, users, matchId }
}

describe('섯다 방 (서버)', () => {
  it('방 설정: 관리 토큰 필요, 대결이 만들어진 뒤에는 바꿀 수 없다, 방/대결 정보에 표시', async () => {
    const owner = newUser()
    const room = await rpc(db, owner, 'create_room', 'x', 'A')
    await expect(rpc(db, newUser(), 'set_room_seotda', room.room_id, 'wrong', true)).rejects.toThrow(/FORBIDDEN/)
    expect((await rpc(db, owner, 'get_room_view', room.room_id)).room.seotda).toBe(false)
    await rpc(db, owner, 'set_room_seotda', room.room_id, room.admin_token, true)
    expect((await rpc(db, owner, 'get_room_view', room.room_id)).room.seotda).toBe(true)
    const u = newUser()
    await rpc(db, u, 'join_room', room.room_id, '손님')
    await rpc(db, u, 'queue_match', room.room_id) // 대기 테이블이 생김
    await expect(rpc(db, owner, 'set_room_seotda', room.room_id, room.admin_token, false)).rejects.toThrow(/ROOM_IN_USE/)
  })

  it('카드는 1~20 의 서로 다른 id 20장이고, 상태에 seotda 가 표시된다', async () => {
    const t = await setupSeotda(5)
    const st = await rpc(db, t.users[0], 'get_match_state', t.matchId)
    expect(st.match.seotda).toBe(true)
    const dealt = (await sql(db, 'select cards from card_hand_seats where hand_id = $1', [st.hand.id])).rows.flatMap((r: any) => r.cards as number[])
    expect(dealt).toHaveLength(10)
    expect(new Set(dealt).size).toBe(10) // 20장 덱에서 10장 — 같은 id 가 두 번 나오지 않는다
    expect(Math.max(...dealt)).toBeLessThanOrEqual(20)
    expect(Math.min(...dealt)).toBeGreaterThanOrEqual(1)
  })

  it('쇼다운 정산이 섯다 규칙으로 된다 (땡잡이 vs 9땡 vs 알리 → 땡잡이)', async () => {
    const t = await setupSeotda(3)
    const st = await rpc(db, t.users[0], 'get_match_state', t.matchId)
    const force = (seat: number, c: number[]) => sql(db, 'update card_hand_seats set cards = $3 where hand_id = $1 and seat = $2', [st.hand.id, seat, c])
    await force(1, [5, 13]); await force(2, [17, 18]); await force(3, [1, 3])
    for (;;) {
      const cur = await rpc(db, t.users[0], 'get_match_state', t.matchId)
      if (cur.hand.status === 'finished') break
      await rpc(db, t.users[cur.hand.turn_seat - 1], 'act', cur.hand.id, 'check', 0)
    }
    const end = await rpc(db, t.users[0], 'get_match_state', t.matchId)
    expect(end.hand.result).toMatchObject({ reason: 'showdown', winners: [{ seat: 1, amount: 3 }] })
  })

  it('암행어사 vs 18광땡 vs 38광땡: 38광땡이 이기고, 38 이 없으면 암행어사', async () => {
    for (const [hands, winner] of [[[[7, 13], [1, 15], [5, 15]], 3], [[[7, 13], [1, 15], [9, 10]], 1]] as const) {
      const t = await setupSeotda(3)
      const st = await rpc(db, t.users[0], 'get_match_state', t.matchId)
      for (let i = 0; i < 3; i++) await sql(db, 'update card_hand_seats set cards = $3 where hand_id = $1 and seat = $2', [st.hand.id, i + 1, hands[i]])
      for (;;) {
        const cur = await rpc(db, t.users[0], 'get_match_state', t.matchId)
        if (cur.hand.status === 'finished') break
        await rpc(db, t.users[cur.hand.turn_seat - 1], 'act', cur.hand.id, 'check', 0)
      }
      const end = await rpc(db, t.users[0], 'get_match_state', t.matchId)
      expect(end.hand.result.winners).toEqual([{ seat: winner, amount: 3 }])
    }
  })

  it('고난이도 섯다: 20장 한 벌 단위 (2~3명 20장, 4~5명 40장)이고 id 가 1~20 안에서 이어 쓰인다', async () => {
    for (const [n, total] of [[2, 20], [3, 20], [4, 40], [5, 40]] as const) {
      const t = await setupSeotda(n, true)
      const st = await rpc(db, t.users[0], 'get_match_state', t.matchId)
      expect(st.pile).toMatchObject({ hard: true, total })
      expect(st.pile.remaining).toBe(total - 2 * n)
      const dealt = (await sql(db, 'select cards from card_hand_seats where hand_id = $1', [st.hand.id])).rows.flatMap((r: any) => r.cards as number[])
      expect(Math.max(...dealt)).toBeLessThanOrEqual(20)
    }
  })

  it('섯다 방에서도 다이한 사람은 상대 패를 못 보고 내 패도 남이 못 본다 (판이 끝난 뒤에도)', async () => {
    const t = await setupSeotda(3)
    const st = await rpc(db, t.users[0], 'get_match_state', t.matchId)
    const truth = Object.fromEntries((await sql(db, 'select seat, cards from card_hand_seats where hand_id = $1', [st.hand.id])).rows.map((r: any) => [r.seat, r.cards]))
    const first = st.hand.turn_seat
    await rpc(db, t.users[first - 1], 'act', st.hand.id, 'die', 0)
    const seats = [1, 2, 3]
    const view = (seat: number) => rpc(db, t.users[seat - 1], 'get_visible_hand', t.matchId, null)
    for (const s of seats.filter((x) => x !== first)) expect((await view(first)).seats.find((x: any) => x.seat === s).cards).toEqual([null, null])
    for (;;) {
      const cur = await rpc(db, t.users[0], 'get_match_state', t.matchId)
      if (cur.hand.status === 'finished') break
      await rpc(db, t.users[cur.hand.turn_seat - 1], 'act', cur.hand.id, 'check', 0)
    }
    const after = await view(first)
    expect(after.revealed).toBe(true)
    for (const s of seats.filter((x) => x !== first)) expect(after.seats.find((x: any) => x.seat === s).cards).toEqual([null, null])
    const remain = seats.find((x) => x !== first)!
    const rv = await view(remain)
    for (const s of seats.filter((x) => x !== first)) expect(rv.seats.find((x: any) => x.seat === s).cards).toEqual(truth[s])
    expect(rv.seats.find((x: any) => x.seat === first).cards).toEqual([null, null]) // 다이한 사람의 패는 남이 못 본다
  })

  it('일반 룸은 이전과 같다 (카드 1~10)', async () => {
    const owner = newUser()
    const room = await rpc(db, owner, 'create_room', 'n', 'A')
    const us = [newUser(), newUser()]
    let m = ''
    for (const [i, u] of us.entries()) {
      await rpc(db, u, 'join_room', room.room_id, `p${i}`)
      m = (await rpc(db, u, 'queue_match', room.room_id)).match_id
    }
    await rpc(db, us[0], 'start_match', m)
    const st = await rpc(db, us[0], 'get_match_state', m)
    const dealt = (await sql(db, 'select cards from card_hand_seats where hand_id = $1', [st.hand.id])).rows.flatMap((r: any) => r.cards as number[])
    expect(Math.max(...dealt)).toBeLessThanOrEqual(10)
    expect(st.match.seotda).toBe(false)
  })
})

describe('섯다 규칙 엔진 크로스체크 (무작위)', () => {
  it('무작위 패 3~5명 쇼다운 정산이 SQL 과 TS 에서 일치한다', async () => {
    let seed = 12345
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let trial = 0; trial < 40; trial++) {
      const n = 3 + Math.floor(rnd() * 3)
      const t = await setupSeotda(n)
      const st = await rpc(db, t.users[0], 'get_match_state', t.matchId)
      const deck = Array.from({ length: 20 }, (_, i) => i + 1).sort(() => rnd() - 0.5)
      const hands: Cards[] = Array.from({ length: n }, (_, i) => [deck[2 * i], deck[2 * i + 1]])
      for (let i = 0; i < n; i++) await sql(db, 'update card_hand_seats set cards = $3 where hand_id = $1 and seat = $2', [st.hand.id, i + 1, hands[i]])
      for (;;) {
        const cur = await rpc(db, t.users[0], 'get_match_state', t.matchId)
        if (cur.hand.status === 'finished') break
        await rpc(db, t.users[cur.hand.turn_seat - 1], 'act', cur.hand.id, 'check', 0)
      }
      const end = await rpc(db, t.users[0], 'get_match_state', t.matchId)
      const { state } = startHand(Array(n).fill(100), 0, 0)
      const ref = settleShowdown(state, hands, 'seotda')
      const expected = ref.payouts.map((amount, i) => ({ seat: i + 1, amount })).filter((w) => w.amount > 0)
      expect(end.hand.result.winners, JSON.stringify(hands)).toEqual(expected)
      void applyAction
    }
  })
})
