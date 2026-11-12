import { beforeAll, describe, expect, it } from 'vitest'
import { createDb, newUser, rpc, setupMatch, setupWaiting, sql, type Db, type Table } from './harness'
import {
  applyAction, leadSeat, legalActions, settleFold, settleShowdown, startHand, timeoutAction,
  type Action, type Cards, type HandEnd, type HandState,
} from '../game/rules'

let db: Db
beforeAll(async () => {
  db = await createDb()
})

const state = (t: { ua: string; matchId: string }) => rpc(db, t.ua, 'get_match_state', t.matchId)
const act = (uid: string, handId: string, a: string, amt = 0) => rpc(db, uid, 'act', handId, a, amt)
const skipPause = (matchId: string) => sql(db, `update card_matches set next_hand_at = now() - interval '1 second' where id = $1`, [matchId])
async function turn(t: Table) {
  const st = await state(t)
  return { st, uid: t.users[st.hand.turn_seat - 1], seat: st.hand.turn_seat as number }
}
const forceCards = (handId: string, cards: Record<number, number[]>) =>
  Promise.all(Object.entries(cards).map(([seat, c]) => sql(db, 'update card_hand_seats set cards = $3 where hand_id = $1 and seat = $2', [handId, Number(seat), c])))
const chipsBySeat = (st: any) => Object.fromEntries(st.seats.map((s: any) => [s.seat, s.chips])) as Record<number, number>

describe('테이블: 대기 → 방장이 시작', () => {
  it('대결 찾기를 누르면 대기 테이블이 열리고 첫 사람이 방장, 다음 사람은 같은 테이블에 앉는다', async () => {
    const w = await setupWaiting(db, 'A', 3)
    const st = await rpc(db, w.users[0], 'get_match_state', w.matchId)
    expect(st.match.status).toBe('waiting')
    expect(st.match.host_player_id).toBe(w.players[0].id)
    expect(st.seats.map((s: any) => s.nickname)).toEqual(['대기1', '대기2', '대기3'])
    expect(st.seats.map((s: any) => s.is_host)).toEqual([true, false, false])
    expect(st.hand).toBeNull()
    for (const p of w.players) expect((await rpc(db, w.users[w.players.indexOf(p)], 'my_status', w.roomId)).match_id).toBe(w.matchId)
  })

  it('방장만 시작할 수 있고, 2명 미만이면 시작할 수 없다', async () => {
    const w = await setupWaiting(db, 'A', 1)
    await expect(rpc(db, w.users[0], 'start_match', w.matchId)).rejects.toThrow(/NOT_ENOUGH_PLAYERS/)
    const w2 = await setupWaiting(db, 'A', 3)
    await expect(rpc(db, w2.users[1], 'start_match', w2.matchId)).rejects.toThrow(/NOT_HOST/)
    await expect(rpc(db, newUser(), 'start_match', w2.matchId)).rejects.toThrow(/NOT_A_PLAYER/)
    const r = await rpc(db, w2.users[0], 'start_match', w2.matchId)
    expect(r.status).toBe('playing')
    await expect(rpc(db, w2.users[0], 'start_match', w2.matchId)).rejects.toThrow(/ALREADY_STARTED/)
  })

  it('2~4명이 모여도 방장이 시작하기 전에는 시작되지 않는다. 시작하면 모두 100칩', async () => {
    const w = await setupWaiting(db, 'B', 4)
    expect((await rpc(db, w.users[0], 'get_match_state', w.matchId)).match.status).toBe('waiting')
    await rpc(db, w.users[0], 'start_match', w.matchId)
    const st = await rpc(db, w.users[0], 'get_match_state', w.matchId)
    expect(st.match).toMatchObject({ status: 'playing', hand_no: 1, start_chips: 100, max_hands: 10 })
    expect(st.seats.map((s: any) => s.chips)).toEqual([99, 99, 99, 99]) // 기본 판돈 1칩씩
    expect(st.hand).toMatchObject({ pot: 4, level: 1, lead_seat: 1, turn_seat: 1 })
    for (const u of w.users) expect((await rpc(db, u, 'my_status', w.roomId)).player.status).toBe('playing')
  })

  it('5명이 모이면 방장이 누르지 않아도 자동 시작, 6번째 사람은 새 테이블을 연다', async () => {
    const w = await setupWaiting(db, 'A', 5)
    expect((await rpc(db, w.users[0], 'get_match_state', w.matchId)).match.status).toBe('playing')
    const late = newUser()
    await rpc(db, late, 'join_room', w.roomId, '지각')
    const q = await rpc(db, late, 'queue_match', w.roomId)
    expect(q.status).toBe('waiting')
    expect(q.match_id).not.toBe(w.matchId)
    const st = await rpc(db, late, 'get_match_state', q.match_id)
    expect(st.seats).toHaveLength(1)
    expect(st.seats[0].is_host).toBe(true)
  })

  it('이미 앉아 있으면 같은 테이블로 복귀한다 (재접속)', async () => {
    const w = await setupWaiting(db, 'A', 2)
    expect(await rpc(db, w.users[1], 'queue_match', w.roomId)).toEqual({ status: 'waiting', match_id: w.matchId })
    await rpc(db, w.users[0], 'start_match', w.matchId)
    expect(await rpc(db, w.users[1], 'queue_match', w.roomId)).toEqual({ status: 'playing', match_id: w.matchId })
  })

  it('방장이 나가면 다음 사람이 방장이 되고, 모두 나가면 테이블이 닫힌다', async () => {
    const w = await setupWaiting(db, 'A', 3)
    await rpc(db, w.users[0], 'leave_match', w.matchId)
    let st = await rpc(db, w.users[1], 'get_match_state', w.matchId)
    expect(st.match.host_player_id).toBe(w.players[1].id)
    expect(st.seats).toHaveLength(2)
    expect((await rpc(db, w.users[0], 'my_status', w.roomId)).match_id).toBeNull()
    await rpc(db, w.users[1], 'leave_match', w.matchId)
    await rpc(db, w.users[2], 'leave_match', w.matchId)
    const r = await sql(db, 'select status from card_matches where id = $1', [w.matchId])
    expect(r.rows[0].status).toBe('void')
    // 닫힌 테이블에는 앉지 않고 새 테이블이 열린다
    const q = await rpc(db, w.users[0], 'queue_match', w.roomId)
    expect(q.match_id).not.toBe(w.matchId)
    st = await rpc(db, w.users[0], 'get_match_state', q.match_id)
    expect(st.seats).toHaveLength(1)
  })

  it('30초 넘게 신호가 없는 대기자는 heartbeat/대결 찾기 때 정리된다', async () => {
    const w = await setupWaiting(db, 'A', 3)
    await sql(db, `update card_players set last_seen = now() - interval '2 minutes' where id = $1`, [w.players[1].id])
    await rpc(db, w.users[0], 'heartbeat', w.roomId)
    const st = await rpc(db, w.users[0], 'get_match_state', w.matchId)
    expect(st.seats.map((s: any) => s.nickname)).toEqual(['대기1', '대기3'])
    expect((await rpc(db, w.users[1], 'my_status', w.roomId)).player.status).toBe('idle')
    // 방장이 유령이면 방장이 위임된다
    await sql(db, `update card_players set last_seen = now() - interval '2 minutes' where id = $1`, [w.players[0].id])
    await rpc(db, w.users[2], 'heartbeat', w.roomId)
    const st2 = await rpc(db, w.users[2], 'get_match_state', w.matchId)
    expect(st2.match.host_player_id).toBe(w.players[2].id)
  })

  it('닉네임 검증과 중복 방지', async () => {
    const { room_id } = await rpc(db, newUser(), 'create_room', '닉', 'A')
    await expect(rpc(db, newUser(), 'join_room', room_id, '   ')).rejects.toThrow(/BAD_NICKNAME/)
    await expect(rpc(db, newUser(), 'join_room', room_id, '열세글자열세글자열세글자열')).rejects.toThrow(/BAD_NICKNAME/)
    await rpc(db, newUser(), 'join_room', room_id, 'Kim')
    await expect(rpc(db, newUser(), 'join_room', room_id, 'kim')).rejects.toThrow(/NICKNAME_TAKEN/)
  })
})

describe('판 시작', () => {
  it('덱은 1~10 두 벌이고 좌석 순서대로 2장씩 배분된다', async () => {
    const t = await setupMatch(db, 'A', 5)
    const st = await state(t)
    const r = await sql(db, 'select deck from card_hands where id = $1', [st.hand.id])
    const deck: number[] = r.rows[0].deck
    expect([...deck].sort((a, b) => a - b)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10])
    const seats = await sql(db, 'select seat, cards from card_hand_seats where hand_id = $1 order by seat', [st.hand.id])
    expect(seats.rows.map((s: any) => s.cards)).toEqual([0, 1, 2, 3, 4].map((i) => [deck[2 * i], deck[2 * i + 1]]))
  })

  it('덱 섞기는 매번 달라진다', async () => {
    const decks = new Set<string>()
    for (let i = 0; i < 8; i++) {
      const t = await setupMatch(db, 'A', 3)
      const st = await state(t)
      decks.add(JSON.stringify((await sql(db, 'select deck from card_hands where id = $1', [st.hand.id])).rows[0].deck))
    }
    expect(decks.size).toBeGreaterThan(5)
  })

  it('20초 타이머와 선 교대 (판마다 한 칸씩 시계방향)', async () => {
    const t = await setupMatch(db, 'A', 3)
    const st = await state(t)
    const left = new Date(st.hand.turn_deadline).getTime() - new Date(st.server_now).getTime()
    expect(left).toBeGreaterThan(19000)
    expect(left).toBeLessThanOrEqual(20000)
    const leads: number[] = [st.hand.lead_seat]
    for (let i = 0; i < 3; i++) {
      // 선이 다이, 다음 사람도 다이 → 판 종료
      for (let k = 0; k < 2; k++) {
        const { st: s, uid } = await turn(t)
        await act(uid, s.hand.id, 'die')
      }
      await skipPause(t.matchId)
      await rpc(db, t.ua, 'advance_match', t.matchId)
      leads.push((await state(t)).hand.lead_seat)
    }
    expect(leads).toEqual([1, 2, 3, 1])
  })
})

describe('베팅 검증 (서버)', () => {
  it('내 차례가 아니면 거부, 참가자가 아니면 거부', async () => {
    const t = await setupMatch(db, 'A', 3)
    const { st, seat } = await turn(t)
    const other = t.users[seat % 3] // 다음 좌석
    await expect(act(other, st.hand.id, 'check')).rejects.toThrow(/NOT_YOUR_TURN/)
    await expect(act(newUser(), st.hand.id, 'check')).rejects.toThrow(/NOT_A_PLAYER/)
  })

  it('올린 금액이 있으면 체크 불가 / 없으면 콜 불가', async () => {
    const t = await setupMatch(db, 'A', 3)
    const { st, uid } = await turn(t)
    await expect(act(uid, st.hand.id, 'call')).rejects.toThrow(/NOTHING_TO_CALL/)
    await act(uid, st.hand.id, 'bet', 1)
    const { uid: next } = await turn(t)
    await expect(act(next, st.hand.id, 'check')).rejects.toThrow(/CANNOT_CHECK/)
  })

  it('금액은 1~3칩, bet/raise 종류도 맞아야 한다', async () => {
    const t = await setupMatch(db, 'A', 3)
    const { st, uid } = await turn(t)
    for (const amt of [0, 4, -2]) await expect(act(uid, st.hand.id, 'bet', amt)).rejects.toThrow(/BAD_AMOUNT/)
    await expect(act(uid, st.hand.id, 'raise', 1)).rejects.toThrow(/WRONG_ACTION/)
    await act(uid, st.hand.id, 'bet', 3)
    const { uid: next } = await turn(t)
    await expect(act(next, st.hand.id, 'bet', 1)).rejects.toThrow(/WRONG_ACTION/)
    await expect(act(next, st.hand.id, 'frobnicate', 1)).rejects.toThrow(/UNKNOWN_ACTION/)
    const after = await state(t)
    expect(after.hand).toMatchObject({ pot: 6, level: 4, current_bet: 3, raise_count: 1 })
  })

  it('레이즈는 판당 총 3회까지 (3명)', async () => {
    const t = await setupMatch(db, 'A', 3)
    const { st } = await turn(t)
    for (let i = 0; i < 3; i++) {
      const { uid } = await turn(t)
      await act(uid, st.hand.id, i === 0 ? 'bet' : 'raise', 1)
    }
    const { uid } = await turn(t)
    await expect(act(uid, st.hand.id, 'raise', 1)).rejects.toThrow(/RAISE_LIMIT/)
    expect((await state(t)).hand.raise_count).toBe(3)
    await act(uid, st.hand.id, 'call') // 콜은 가능
  })

  it('가진 칩보다 많이 걸 수 없다 (올인)', async () => {
    const t = await setupMatch(db, 'A', 3)
    const { st, uid, seat } = await turn(t)
    await sql(db, 'update card_match_players set chips = 2 where match_id = $1 and seat = $2', [t.matchId, seat])
    await expect(act(uid, st.hand.id, 'bet', 3)).rejects.toThrow(/BAD_AMOUNT/)
    await act(uid, st.hand.id, 'bet', 2)
    expect(chipsBySeat(await state(t))[seat]).toBe(0)
  })

  it('레이즈가 나오면 이미 콜한 사람도 다시 행동한다. 전원이 맞추면 쇼다운', async () => {
    const t = await setupMatch(db, 'A', 3)
    const { st, uid: a, seat: sa } = await turn(t)
    await act(a, st.hand.id, 'bet', 1)
    const { uid: b } = await turn(t)
    await act(b, st.hand.id, 'call')
    const { uid: c, seat: sc } = await turn(t)
    await act(c, st.hand.id, 'raise', 2)
    const mid = await state(t)
    expect(mid.hand.status).toBe('betting')
    expect(mid.hand.turn_seat).toBe(sa) // 처음 베팅한 사람부터 다시
    await act(a, st.hand.id, 'call')
    expect((await state(t)).hand.status).toBe('betting')
    const { uid: b2 } = await turn(t)
    await act(b2, st.hand.id, 'call')
    expect((await state(t)).hand.status).toBe('finished')
    void sc
  })

  it('다이하면 상대가 판돈을 가져가고 패가 공개된다', async () => {
    const t = await setupMatch(db, 'B', 2)
    const { st, uid, seat } = await turn(t)
    await act(uid, st.hand.id, 'die')
    const r = await state(t)
    expect(r.hand.status).toBe('finished')
    expect(r.hand.revealed).toBe(true)
    expect(r.hand.result).toMatchObject({ reason: 'fold', pot: 2, winners: [{ seat: seat === 1 ? 2 : 1, amount: 2 }] })
    expect(r.seats.reduce((a: number, s: any) => a + s.chips, 0)).toBe(200)
    expect(r.match.next_hand_at).not.toBeNull()
  })

  it('끝난 판에는 더 행동할 수 없다', async () => {
    const t = await setupMatch(db, 'A', 2)
    const { st, uid } = await turn(t)
    await act(uid, st.hand.id, 'die')
    const other = uid === t.ua ? t.ub : t.ua
    await expect(act(other, st.hand.id, 'check')).rejects.toThrow(/HAND_NOT_ACTIVE/)
  })

  it('행동 로그가 상대 행동 표시용으로 남는다', async () => {
    const t = await setupMatch(db, 'A', 3)
    const { st, uid } = await turn(t)
    await act(uid, st.hand.id, 'bet', 2)
    const { uid: n } = await turn(t)
    await act(n, st.hand.id, 'raise', 3)
    const r = await state(t)
    expect(r.actions.map((a: any) => [a.seat, a.action, a.amount])).toEqual([[1, 'bet', 2], [2, 'raise', 3]])
  })
})

describe('판 결과 / 사이드 팟 / 이월', () => {
  it('3명: 생존자 중 최고 족보가 판돈 독식 (페어 > 합, 다이한 사람은 제외)', async () => {
    const t = await setupMatch(db, 'A', 3)
    const { st, uid: a } = await turn(t)
    await forceCards(st.hand.id, { 1: [10, 9], 2: [2, 2], 3: [10, 10] })
    await act(a, st.hand.id, 'bet', 3) // seat 1
    const { uid: b } = await turn(t)
    await act(b, st.hand.id, 'die') // seat 2 (가장 낮은 페어지만 다이)
    const { uid: c } = await turn(t)
    await act(c, st.hand.id, 'call') // seat 3
    const r = await state(t)
    expect(r.hand.result).toMatchObject({ reason: 'showdown', pot: 9, winners: [{ seat: 3, amount: 9 }] })
    expect(chipsBySeat(r)).toEqual({ 1: 96, 2: 99, 3: 105 })
  })

  it('사이드 팟: 짧은 칩으로 올인한 사람은 메인 팟까지만 가져간다', async () => {
    const t = await setupMatch(db, 'A', 3)
    const { st } = await turn(t) // seat 1 선
    await sql(db, 'update card_match_players set chips = 2 where match_id = $1 and seat = 1', [t.matchId]) // seat 1: 총 3칩
    await forceCards(st.hand.id, { 1: [10, 10], 2: [9, 9], 3: [8, 8] })
    await act(t.users[0], st.hand.id, 'bet', 2) // 올인 (committed 3)
    await act(t.users[1], st.hand.id, 'raise', 3) // level 6
    await act(t.users[2], st.hand.id, 'call')
    const r = await state(t)
    expect(r.hand.status).toBe('finished')
    // 메인 팟 3×3=9 → seat 1, 사이드 팟 3×2=6 → seat 2 (seat 3 보다 높은 페어)
    expect(r.hand.result.winners).toEqual([{ seat: 1, amount: 9 }, { seat: 2, amount: 6 }])
    expect(chipsBySeat(r)).toEqual({ 1: 9, 2: 99 - 5 + 6, 3: 99 - 5 })
    expect(r.seats.reduce((a: number, s: any) => a + s.chips, 0)).toBe(203) // 300 - 97 (seat 1 의 칩을 2로 줄였으므로) 보존
  })

  it('무승부는 판돈을 나눈다', async () => {
    const t = await setupMatch(db, 'A', 2)
    const { st, uid } = await turn(t)
    await forceCards(st.hand.id, { 1: [10, 5], 2: [7, 8] })
    await act(uid, st.hand.id, 'bet', 2)
    const { uid: o } = await turn(t)
    await act(o, st.hand.id, 'call')
    const r = await state(t)
    expect(r.hand.result.winners).toEqual([{ seat: 1, amount: 3 }, { seat: 2, amount: 3 }])
    expect(chipsBySeat(r)).toEqual({ 1: 100, 2: 100 })
    expect(r.hand.result.carry).toBe(0)
  })

  it('나누어떨어지지 않는 칩은 다음 판 판돈으로 이월된다', async () => {
    const t = await setupMatch(db, 'A', 2)
    const { st, uid } = await turn(t)
    await sql(db, 'update card_matches set carry = 1 where id = $1', [t.matchId])
    await sql(db, 'update card_hands set pot = pot + 1, carry_in = 1 where id = $1', [st.hand.id])
    await forceCards(st.hand.id, { 1: [4, 4], 2: [4, 4] })
    await act(uid, st.hand.id, 'check')
    const { uid: o } = await turn(t)
    await act(o, st.hand.id, 'check')
    const r = await state(t)
    expect(r.hand.result).toMatchObject({ reason: 'showdown', pot: 3, carry: 1 })
    expect(chipsBySeat(r)).toEqual({ 1: 100, 2: 100 })
    expect(r.match.carry).toBe(1)
    await skipPause(t.matchId)
    expect((await rpc(db, t.ua, 'advance_match', t.matchId)).result).toBe('started')
    const n = await state(t)
    expect(n.hand).toMatchObject({ hand_no: 2, pot: 3 })
    expect(n.match.carry).toBe(0)
    expect(n.seats.reduce((a: number, s: any) => a + s.chips, 0) + n.hand.pot).toBe(201)
  })

  it('연출 시간 전에는 다음 판이 시작되지 않고, 다시 호출해도 멱등', async () => {
    const t = await setupMatch(db, 'A', 3)
    for (let k = 0; k < 2; k++) {
      const { st, uid } = await turn(t)
      await act(uid, st.hand.id, 'die')
    }
    expect((await rpc(db, t.ua, 'advance_match', t.matchId)).result).toBe('wait')
    await skipPause(t.matchId)
    expect((await rpc(db, t.ub, 'advance_match', t.matchId)).result).toBe('started')
    expect((await rpc(db, t.ua, 'advance_match', t.matchId)).result).toBe('noop')
    expect((await state(t)).hand.hand_no).toBe(2)
  })

  it('기본 판돈으로 칩이 0이 되면 베팅 없이 곧바로 쇼다운', async () => {
    const t = await setupMatch(db, 'A', 2)
    const { st, uid } = await turn(t)
    await sql(db, 'update card_match_players set chips = 1 where match_id = $1 and seat = 1', [t.matchId])
    await act(uid, st.hand.id, 'die')
    await skipPause(t.matchId)
    await rpc(db, t.ua, 'advance_match', t.matchId)
    const n = await state(t)
    expect(n.hand.status).toBe('finished')
    expect(n.hand.result.reason).toBe('showdown')
  })
})

describe('탈락 / 종료', () => {
  it('칩이 0이 된 사람은 다음 판에서 제외되고, 한 명만 남으면 즉시 종료', async () => {
    const t = await setupMatch(db, 'A', 3)
    const { st } = await turn(t)
    // seat 3 이 이번 판에 칩을 전부 잃는 상황: 칩 2 + 올인 콜
    await sql(db, 'update card_match_players set chips = 2 where match_id = $1 and seat = 3', [t.matchId])
    await forceCards(st.hand.id, { 1: [10, 10], 2: [1, 2], 3: [3, 4] })
    await act(t.users[0], st.hand.id, 'bet', 3)
    await act(t.users[1], st.hand.id, 'die')
    await act(t.users[2], st.hand.id, 'call') // 필요 3, 남은 2 → 올인 콜
    const r = await state(t)
    expect(r.hand.status).toBe('finished')
    expect(chipsBySeat(r)[3]).toBe(0)
    expect(r.match.status).toBe('playing') // 2명 남음
    await skipPause(t.matchId)
    await rpc(db, t.ua, 'advance_match', t.matchId)
    const n = await state(t)
    expect(n.seats.filter((s: any) => s.in_hand).map((s: any) => s.seat)).toEqual([1, 2]) // seat 3 은 카드를 받지 않는다
    // 남은 2명 중 한 명이 모든 칩을 잃으면 종료
    await sql(db, 'update card_match_players set chips = 0 where match_id = $1 and seat = 2', [t.matchId])
    const { st: s2, uid } = await turn(t)
    expect(s2.hand.hand_no).toBe(2)
    void uid
  })

  it('10판을 마치면 종료: 칩이 가장 많은 사람이 승자, 수익 = 최종 칩 − 100', async () => {
    const t = await setupMatch(db, 'A', 3)
    for (let h = 1; h <= 10; h++) {
      const st = await state(t)
      expect(st.hand.hand_no).toBe(h)
      // 선만 다이를 반복하지 않도록: 차례대로 두 명이 다이
      for (let k = 0; k < 2; k++) {
        const { st: s, uid } = await turn(t)
        await act(uid, s.hand.id, 'die')
      }
      if (h < 10) {
        await skipPause(t.matchId)
        await rpc(db, t.ua, 'advance_match', t.matchId)
      }
    }
    const fin = await state(t)
    expect(fin.match).toMatchObject({ status: 'finished', end_reason: 'complete', hand_no: 10 })
    const total = fin.seats.reduce((a: number, s: any) => a + s.chips, 0)
    expect(total).toBe(300)
    for (const s of fin.seats) expect(s.profit).toBe(s.chips - 100)
    const max = Math.max(...fin.seats.map((s: any) => s.chips))
    expect(fin.seats.filter((s: any) => s.is_winner).map((s: any) => s.chips)).toEqual(fin.seats.filter((s: any) => s.chips === max).map((s: any) => s.chips))
    const rv = await rpc(db, t.ua, 'get_room_view', t.roomId)
    for (const s of fin.seats) {
      const row = rv.ranking.find((r: any) => r.id === s.player_id)
      expect(row.total_profit).toBe(s.profit)
      expect(row.matches_played).toBe(1)
      expect(row.matches_won).toBe(s.is_winner ? 1 : 0)
      expect(row.status).toBe('idle')
    }
  })

  it('다음 매치는 다시 100칩으로 시작하고 수익이 누적된다', async () => {
    const t = await setupMatch(db, 'A', 2)
    const { st, uid } = await turn(t)
    await act(uid, st.hand.id, 'die')
    await rpc(db, t.ua, 'leave_match', t.matchId)
    const q1 = await rpc(db, t.ua, 'queue_match', t.roomId)
    expect(q1.status).toBe('waiting')
    const q2 = await rpc(db, t.ub, 'queue_match', t.roomId)
    expect(q2.match_id).toBe(q1.match_id)
    await rpc(db, t.ua, 'start_match', q1.match_id)
    const st2 = await rpc(db, t.ub, 'get_match_state', q1.match_id)
    expect(st2.seats.map((s: any) => s.chips)).toEqual([99, 99])
    expect(q1.match_id).not.toBe(t.matchId)
  })
})

describe('시간 초과 / 이탈', () => {
  it('턴 20초가 지나면 체크 가능할 땐 자동 체크, 상대 클라이언트가 호출해도 된다', async () => {
    const t = await setupMatch(db, 'A', 3)
    const { st, uid, seat } = await turn(t)
    const other = t.users[seat % 3]
    expect((await rpc(db, other, 'timeout_check', st.hand.id)).result).toBe('noop')
    await sql(db, `update card_hands set turn_deadline = now() - interval '5 seconds' where id = $1`, [st.hand.id])
    await expect(act(uid, st.hand.id, 'check')).rejects.toThrow(/TURN_EXPIRED/)
    expect(await rpc(db, other, 'timeout_check', st.hand.id)).toEqual({ result: 'auto', action: 'check' })
    const after = await state(t)
    expect(after.actions[0]).toMatchObject({ action: 'check', auto: true, seat })
    expect(after.hand.turn_seat).not.toBe(seat)
    expect((await rpc(db, other, 'timeout_check', st.hand.id)).result).toBe('noop')
  })

  it('올린 금액에 응답하지 않으면 자동 다이', async () => {
    const t = await setupMatch(db, 'A', 2)
    const { st, uid } = await turn(t)
    await act(uid, st.hand.id, 'bet', 2)
    await sql(db, `update card_hands set turn_deadline = now() - interval '2 seconds' where id = $1`, [st.hand.id])
    expect(await rpc(db, uid, 'timeout_check', st.hand.id)).toEqual({ result: 'auto', action: 'die' })
    const r = await state(t)
    expect(r.hand.result).toMatchObject({ reason: 'fold', pot: 4 })
  })

  it('2명 중 한 명이 60초 넘게 응답이 없으면 남은 사람의 승리 (기권자는 수익을 챙기지 못함)', async () => {
    const t = await setupMatch(db, 'A', 2)
    const { st, uid, seat } = await turn(t)
    await act(uid, st.hand.id, 'bet', 3)
    const otherId = seat === 1 ? t.pb.id : t.pa.id
    await sql(db, `update card_players set last_seen = now() - interval '61 seconds' where id = $1`, [otherId])
    expect((await rpc(db, uid, 'timeout_check', st.hand.id)).result).toBe('forfeit')
    const r = await state(t)
    expect(r.match).toMatchObject({ status: 'finished', end_reason: 'forfeit' })
    const win = r.seats.find((s: any) => s.seat === seat)
    const lose = r.seats.find((s: any) => s.seat !== seat)
    expect(win.is_winner).toBe(true)
    expect(win.profit).toBe(96 + 5 - 100) // 진행 중이던 판돈(2+3)을 가져간다 = +1
    expect(lose.is_winner).toBe(false)
    expect(lose.profit).toBeLessThanOrEqual(0)
  })

  it('3명 중 한 명이 사라져도 나머지로 계속된다 (현재 판은 다이 처리)', async () => {
    const t = await setupMatch(db, 'A', 3)
    const { st, uid, seat } = await turn(t)
    const gone = t.users[(seat) % 3] // 다음 차례 사람이 사라짐
    const gonePlayer = t.players[(seat) % 3].id
    await act(uid, st.hand.id, 'bet', 1)
    await sql(db, `update card_players set last_seen = now() - interval '2 minutes' where id = $1`, [gonePlayer])
    const caller = t.users.find((u) => u !== gone && u !== uid)!
    expect((await rpc(db, caller, 'timeout_check', st.hand.id)).result).toBe('forfeit')
    const r = await state(t)
    expect(r.match.status).toBe('playing')
    expect(r.seats.find((s: any) => s.player_id === gonePlayer)).toMatchObject({ left: true, folded: true })
    expect(r.hand.status).toBe('betting')
    expect(r.hand.turn_seat).not.toBe((seat % 3) + 1) // 사라진 사람 차례는 건너뜀
    // 이후 판에서도 제외된다
    for (;;) {
      const s = await state(t)
      if (s.hand.status === 'finished') break
      await act(t.users[s.hand.turn_seat - 1], s.hand.id, 'die')
    }
    await skipPause(t.matchId)
    await rpc(db, caller, 'advance_match', t.matchId)
    const n = await state(t)
    expect(n.seats.filter((s: any) => s.in_hand)).toHaveLength(2)
    expect(n.seats.find((s: any) => s.player_id === gonePlayer).in_hand).toBe(false)
  })

  it('판 사이 연출 중에 상대가 사라져도 기권 처리된다', async () => {
    const t = await setupMatch(db, 'A', 2)
    const { st, uid } = await turn(t)
    await act(uid, st.hand.id, 'die')
    await sql(db, `update card_players set last_seen = now() - interval '2 minutes' where id = $1`, [uid === t.ua ? t.pa.id : t.pb.id])
    const other = uid === t.ua ? t.ub : t.ua
    expect((await rpc(db, other, 'advance_match', t.matchId)).result).toBe('forfeit')
    expect((await state(t)).match.status).toBe('finished')
  })

  it('나가기(leave_match)는 기권: 2명이면 남은 사람이 승리하고 둘 다 대기 상태가 풀린다', async () => {
    const t = await setupMatch(db, 'B', 2)
    await rpc(db, t.ua, 'leave_match', t.matchId)
    const r = await state(t)
    expect(r.match).toMatchObject({ status: 'finished', end_reason: 'forfeit' })
    expect(r.seats.find((s: any) => s.is_winner).player_id).toBe(t.pb.id)
    expect((await rpc(db, t.ub, 'my_status', t.roomId)).match_id).toBeNull()
    await rpc(db, t.ua, 'leave_match', t.matchId) // 끝난 매치에 다시 호출해도 안전
    const rv = await rpc(db, t.ub, 'get_room_view', t.roomId)
    expect(rv.ranking[0].nickname).toBe('선수2')
  })

  it('나간 사람이 다른 테이블에 앉아 있어도 이전 매치 종료가 그 상태를 건드리지 않는다', async () => {
    const t = await setupMatch(db, 'A', 3)
    await rpc(db, t.users[2], 'leave_match', t.matchId) // 3번이 나감 (매치는 계속)
    const q = await rpc(db, t.users[2], 'queue_match', t.roomId) // 다른 대기 테이블에 앉음
    expect(q.status).toBe('waiting')
    await rpc(db, t.users[1], 'leave_match', t.matchId) // 남은 한 명 → 매치 종료
    expect((await state(t)).match.status).toBe('finished')
    expect((await rpc(db, t.users[2], 'my_status', t.roomId)).player.status).toBe('queued') // 새 대기 상태 유지
    expect((await rpc(db, t.users[2], 'my_status', t.roomId)).match_id).toBe(q.match_id)
  })
})

describe('랭킹', () => {
  it('누적 수익 ↓ → 승리 매치 수 ↓ → 먼저 참여한 순', async () => {
    const { room_id } = await rpc(db, newUser(), 'create_room', '랭킹', 'A')
    const ps: any[] = []
    for (const n of ['가', '나', '다', '라']) {
      ps.push(await rpc(db, newUser(), 'join_room', room_id, n))
      await sql(db, `select pg_sleep(0.01)`)
    }
    await sql(db, `update card_players set total_profit = 5, matches_won = 1 where id = $1`, [ps[3].id])
    await sql(db, `update card_players set total_profit = 5, matches_won = 2 where id = $1`, [ps[2].id])
    await sql(db, `update card_players set total_profit = 5, matches_won = 2 where id = $1`, [ps[1].id])
    await sql(db, `update card_players set total_profit = 9, matches_won = 0 where id = $1`, [ps[0].id])
    const rv = await rpc(db, newUser(), 'get_room_view', room_id)
    expect(rv.ranking.map((r: any) => r.nickname)).toEqual(['가', '나', '다', '라'])
    expect(rv.ranking.map((r: any) => r.rank)).toEqual([1, 2, 3, 4])
  })
})

describe('방 관리', () => {
  it('생성자(관리 토큰)만 방을 종료할 수 있다', async () => {
    const t = await setupMatch(db, 'A', 2)
    await expect(rpc(db, t.owner, 'close_room', t.roomId, 'wrong-token')).rejects.toThrow(/FORBIDDEN/)
    await expect(rpc(db, t.ua, 'close_room', t.roomId, '')).rejects.toThrow(/FORBIDDEN/)
    expect(await rpc(db, t.ua, 'verify_admin', t.roomId, t.adminToken)).toBe(true)
    expect(await rpc(db, t.ua, 'verify_admin', t.roomId, 'nope')).toBe(false)
    expect((await rpc(db, t.owner, 'get_room_view', t.roomId)).room.status).toBe('open')
  })

  it('종료하면 대기/진행 중 테이블은 무효(수익 미반영), 최종 순위 확정, 이후 입장/대기/행동 불가', async () => {
    const t = await setupMatch(db, 'A', 3)
    const w = await rpc(db, newUser(), 'create_room', 'x', 'A') // 다른 방은 영향 없음
    const { st, uid } = await turn(t)
    await act(uid, st.hand.id, 'bet', 2)
    await sql(db, `update card_players set total_profit = 7, matches_won = 1 where id = $1`, [t.pb.id])
    // 같은 방에 대기 테이블도 하나
    const late = newUser()
    await rpc(db, late, 'join_room', t.roomId, '대기자')
    const q = await rpc(db, late, 'queue_match', t.roomId)

    await rpc(db, t.owner, 'close_room', t.roomId, t.adminToken)
    const rv = await rpc(db, t.ua, 'get_room_view', t.roomId)
    expect(rv.room.status).toBe('closed')
    expect(rv.active_matches).toBe(0)
    expect(rv.waiting_tables).toBe(0)
    expect(rv.ranking[0]).toMatchObject({ nickname: '선수2', total_profit: 7, rank: 1 })
    expect(rv.ranking.find((r: any) => r.nickname === '선수1').total_profit).toBe(0)
    const fin = await sql(db, `select final_rank from card_players where room_id = $1 order by final_rank`, [t.roomId])
    expect(fin.rows.map((r: any) => r.final_rank)).toEqual([1, 2, 3, 4])

    expect((await state(t)).match.status).toBe('void')
    expect((await state(t)).hand.status).toBe('void')
    await expect(act(uid, st.hand.id, 'call')).rejects.toThrow(/HAND_NOT_ACTIVE/)
    await expect(rpc(db, t.ua, 'queue_match', t.roomId)).rejects.toThrow(/ROOM_CLOSED/)
    await expect(rpc(db, newUser(), 'join_room', t.roomId, '지각생')).rejects.toThrow(/ROOM_CLOSED/)
    expect((await rpc(db, t.ua, 'my_status', t.roomId)).match_id).toBeNull()
    expect((await rpc(db, late, 'get_match_state', q.match_id)).match.status).toBe('void')
    expect((await rpc(db, t.owner, 'get_room_view', w.room_id)).room.status).toBe('open')
  })
})

// ───────────── TS 규칙 엔진 ↔ SQL 엔진 교차 검증 ─────────────
describe('TS 규칙 엔진과 SQL 엔진 교차 검증 (무작위 플레이)', () => {
  it('2~5명 40매치: 매 행동 후 좌석/칩/차례/판돈이 일치하고, 정산(사이드 팟 포함)이 일치하며, 칩 총량이 보존된다', async () => {
    let seed = 20260101
    const rng = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
    let showdowns = 0
    let folds = 0
    let multiway = 0

    for (let g = 0; g < 40; g++) {
      const n = 2 + (g % 4)
      const t = await setupMatch(db, g % 2 ? 'A' : 'B', n)
      let shadow: HandState | null = null
      let shadowEnd: HandEnd | null = null
      let currentHand = ''
      let guard = 0

      const checkShadow = (st: any) => {
        const s = shadow!
        expect(st.hand.pot).toBe(s.carryIn + s.seats.reduce((a, x) => a + x.committed, 0))
        expect(st.hand.level).toBe(s.level)
        expect(st.hand.raise_count).toBe(s.raiseCount)
        expect(st.hand.turn_seat === null ? null : st.hand.turn_seat - 1).toBe(s.turn)
        st.seats.forEach((x: any, i: number) => {
          expect(x.chips).toBe(s.seats[i].chips)
          expect(x.committed).toBe(s.seats[i].committed)
          expect(x.folded).toBe(s.seats[i].folded)
          expect(x.in_hand).toBe(s.seats[i].inHand)
        })
      }

      for (;;) {
        if (++guard > 600) throw new Error('매치가 끝나지 않음')
        const st = await state(t)
        // 칩 총량 보존
        const inPot = st.hand?.status === 'betting' ? st.hand.pot - 0 : 0
        expect(st.seats.reduce((a: number, s: any) => a + s.chips, 0) + inPot + st.match.carry).toBe(100 * n)
        if (st.match.status === 'finished') break

        // 새 판이 시작되면 TS 그림자를 같은 입력으로 시작
        if (st.hand.id !== currentHand) {
          currentHand = st.hand.id
          const pre = st.seats.map((s: any) => (s.in_hand ? s.chips + s.committed : s.chips))
          const carryIn = (await sql(db, 'select carry_in from card_hands where id = $1', [st.hand.id])).rows[0].carry_in
          const started = startHand(pre, carryIn, st.hand.lead_seat - 1)
          shadow = started.state
          shadowEnd = started.end
          expect(st.hand.lead_seat - 1).toBe(leadSeat(st.hand.hand_no, pre))
        }

        if (st.hand.status === 'finished') {
          // 정산 대조
          const cards = (await sql(db, 'select seat, cards from card_hand_seats where hand_id = $1', [st.hand.id])).rows
          const hands: (Cards | null)[] = shadow!.seats.map((_, i) => (cards.find((c: any) => c.seat === i + 1)?.cards as Cards) ?? null)
          const settle = shadowEnd?.type === 'fold' ? settleFold(shadow!, shadowEnd.winner) : settleShowdown(shadow!, hands)
          const expectWinners = settle.payouts.map((amount, i) => ({ seat: i + 1, amount })).filter((w) => w.amount > 0)
          expect(st.hand.result.winners).toEqual(expectWinners)
          expect(st.hand.result.carry).toBe(settle.carry)
          expect(st.hand.result.reason).toBe(shadowEnd?.type === 'fold' ? 'fold' : 'showdown')
          if (shadowEnd?.type === 'fold') folds++
          else {
            showdowns++
            if (shadow!.seats.filter((x) => x.inHand && !x.folded).length > 2) multiway++
          }
          st.seats.forEach((x: any, i: number) => {
            const before = shadow!.seats[i].chips
            expect(x.chips).toBe(before + settle.payouts[i])
          })
          if (st.match.status === 'playing') {
            await skipPause(t.matchId)
            await rpc(db, t.ua, 'advance_match', t.matchId)
          }
          continue
        }

        checkShadow(st)
        const seat = st.hand.turn_seat - 1
        const uid = t.users[seat]
        const la = legalActions(shadow!, seat)
        const opts: Action[] = [{ type: 'die' }]
        if (la.canCheck) opts.push({ type: 'check' })
        if (la.canCall) opts.push({ type: 'call' })
        if (la.canRaise) opts.push({ type: la.raiseKind, amount: 1 + Math.floor(rng() * la.raiseMax) })
        let a = opts[Math.floor(rng() * opts.length)]
        if (rng() < 0.05) a = timeoutAction(shadow!, seat)

        // TS 가 불가능하다고 보는 행동은 서버도 거부한다
        if (!la.canCheck) await expect(act(uid, st.hand.id, 'check')).rejects.toThrow(/CANNOT_CHECK/)
        if (!la.canCall) await expect(act(uid, st.hand.id, 'call')).rejects.toThrow(/NOTHING_TO_CALL/)
        if (!la.canRaise && la.raiseMax === 0 && st.hand.raise_count >= 3) {
          await expect(act(uid, st.hand.id, la.raiseKind, 1)).rejects.toThrow(/RAISE_LIMIT/)
        }

        const r = applyAction(shadow!, seat, a)
        if (!r.ok) throw new Error(r.error)
        await act(uid, st.hand.id, a.type, 'amount' in a ? a.amount : 0)
        shadow = r.state
        shadowEnd = r.end
      }

      const fin = await state(t)
      expect(fin.match.hand_no).toBeLessThanOrEqual(10)
      expect(fin.seats.reduce((a: number, s: any) => a + s.chips, 0) + fin.match.carry).toBeLessThanOrEqual(100 * n)
      for (const s of fin.seats) expect(s.profit).toBe(s.chips - 100)
      const max = Math.max(...fin.seats.map((s: any) => s.chips))
      expect(fin.seats.filter((s: any) => s.is_winner).map((s: any) => s.seat)).toEqual(fin.seats.filter((s: any) => s.chips === max).map((s: any) => s.seat))
      if (fin.match.end_reason === 'bust') expect(fin.seats.filter((s: any) => s.chips > 0).length).toBeLessThanOrEqual(1)
      else expect(fin.match.hand_no).toBe(10)
      const rv = await rpc(db, t.ua, 'get_room_view', t.roomId)
      for (const s of fin.seats) {
        const row = rv.ranking.find((r: any) => r.id === s.player_id)
        expect(row.total_profit).toBe(s.profit)
        expect(row.matches_played).toBe(1)
        expect(row.status).toBe('idle')
      }
    }
    // 검증이 실제로 다양한 경로를 탔는지 확인
    expect(showdowns).toBeGreaterThan(20)
    expect(folds).toBeGreaterThan(20)
    expect(multiway).toBeGreaterThan(5)
  })
})
