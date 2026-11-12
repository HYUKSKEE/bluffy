import { beforeAll, describe, expect, it } from 'vitest'
import { createDb, newUser, rpc, setupMatch, sql, type Db } from './harness'
import { legalActions, type BettingState } from '../game/rules'

let db: Db
beforeAll(async () => {
  db = await createDb()
})

type S = Awaited<ReturnType<typeof setupMatch>>
const state = (s: S) => rpc(db, s.ua, 'get_match_state', s.matchId)
/** 현재 차례인 사람의 uid */
async function actor(s: S) {
  const st = await state(s)
  return { st, uid: st.hand.turn_player_id === s.pa.id ? s.ua : s.ub, other: st.hand.turn_player_id === s.pa.id ? s.ub : s.ua }
}
const act = (uid: string, handId: string, a: string, amt = 0) => rpc(db, uid, 'act', handId, a, amt)
const skipPause = (matchId: string) => sql(db, `update card_matches set next_hand_at = now() - interval '1 second' where id = $1`, [matchId])
const bettingOf = (st: any): BettingState => ({
  stacks: [st.match.chips1, st.match.chips2],
  committed: [st.hand.committed1, st.hand.committed2],
  pot: st.hand.pot,
  turn: st.hand.turn_player_id === st.match.player1.id ? 0 : 1,
  raiseCount: st.hand.raise_count,
  checks: st.hand.checks,
})

describe('매칭', () => {
  it('먼저 대기한 순서로 1:1 매칭된다', async () => {
    const owner = newUser(), u = [newUser(), newUser(), newUser(), newUser()]
    const { room_id } = await rpc(db, owner, 'create_room', '큐', 'A')
    const p: any[] = []
    for (let i = 0; i < 4; i++) p.push(await rpc(db, u[i], 'join_room', room_id, `선수${i}`))
    expect((await rpc(db, u[0], 'queue_match', room_id)).status).toBe('queued')
    expect((await rpc(db, u[1], 'my_status', room_id)).match_id).toBeNull()
    const m = await rpc(db, u[1], 'queue_match', room_id) // 대기 중이던 u0 와 즉시 매칭
    expect(m.status).toBe('matched')
    const st = await rpc(db, u[1], 'get_match_state', m.match_id)
    expect(st.match.player1.id).toBe(p[0].id) // 먼저 대기한 사람이 player1(1판의 선)
    expect(st.match.player2.id).toBe(p[1].id)
    expect((await rpc(db, u[0], 'my_status', room_id)).match_id).toBe(m.match_id) // 대기자도 매치를 발견
    // 매칭된 사람은 다시 대기열에 들어가지 않으므로 다음 두 명끼리 매칭된다
    expect((await rpc(db, u[2], 'queue_match', room_id)).status).toBe('queued')
    const m2 = await rpc(db, u[3], 'queue_match', room_id)
    expect(m2.status).toBe('matched')
    expect(m2.match_id).not.toBe(m.match_id)
  })

  it('이미 매치 중이면 같은 매치로 복귀하고(재접속), 자기 자신과는 매칭되지 않는다', async () => {
    const s = await setupMatch(db, 'A')
    const again = await rpc(db, s.ua, 'queue_match', s.roomId)
    expect(again).toEqual({ status: 'matched', match_id: s.matchId })
    expect((await rpc(db, s.ua, 'my_status', s.roomId)).match_id).toBe(s.matchId)
    const solo = newUser()
    const room = await rpc(db, solo, 'create_room', '혼자', 'B')
    await rpc(db, solo, 'join_room', room.room_id, '솔로')
    expect((await rpc(db, solo, 'queue_match', room.room_id)).status).toBe('queued')
    expect((await rpc(db, solo, 'queue_match', room.room_id)).status).toBe('queued')
  })

  it('30초 넘게 신호가 없는 대기자는 건너뛴다', async () => {
    const owner = newUser(), a = newUser(), b = newUser()
    const { room_id } = await rpc(db, owner, 'create_room', '유령', 'A')
    const pa = await rpc(db, a, 'join_room', room_id, '유령')
    await rpc(db, b, 'join_room', room_id, '산사람')
    await rpc(db, a, 'queue_match', room_id)
    await sql(db, `update card_players set last_seen = now() - interval '2 minutes' where id = $1`, [pa.id])
    expect((await rpc(db, b, 'queue_match', room_id)).status).toBe('queued')
  })

  it('닉네임 검증과 중복 방지', async () => {
    const owner = newUser()
    const { room_id } = await rpc(db, owner, 'create_room', '닉', 'A')
    await expect(rpc(db, newUser(), 'join_room', room_id, '   ')).rejects.toThrow(/BAD_NICKNAME/)
    await expect(rpc(db, newUser(), 'join_room', room_id, '열세글자열세글자열세글자열')).rejects.toThrow(/BAD_NICKNAME/)
    await rpc(db, newUser(), 'join_room', room_id, 'Kim')
    await expect(rpc(db, newUser(), 'join_room', room_id, 'kim')).rejects.toThrow(/NICKNAME_TAKEN/)
  })
})

describe('판 시작', () => {
  it('기본 판돈 1칩씩, 선 플레이어가 먼저, 20초 타이머', async () => {
    const s = await setupMatch(db, 'A')
    const st = await state(s)
    expect(st.match).toMatchObject({ chips1: 19, chips2: 19, hand_no: 1 })
    expect(st.hand).toMatchObject({ pot: 2, committed1: 1, committed2: 1, status: 'betting', raise_count: 0 })
    expect(st.hand.turn_player_id).toBe(s.pa.id) // 1판의 선 = player1
    const left = new Date(st.hand.turn_deadline).getTime() - new Date(st.server_now).getTime()
    expect(left).toBeGreaterThan(19000)
    expect(left).toBeLessThanOrEqual(20000)
  })

  it('덱은 1~10 두 벌이고 배분된 4장은 덱의 앞 4장', async () => {
    const s = await setupMatch(db, 'A')
    const st = await state(s)
    const r = await sql(db, 'select deck, cards1, cards2 from card_hands where id = $1', [st.hand.id])
    const { deck, cards1, cards2 } = r.rows[0]
    expect([...deck].sort((a: number, b: number) => a - b)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10])
    expect([...cards1, ...cards2]).toEqual(deck.slice(0, 4))
  })

  it('덱 섞기는 매번 달라진다', async () => {
    const decks = new Set<string>()
    for (let i = 0; i < 8; i++) {
      const s = await setupMatch(db, 'A')
      const st = await state(s)
      decks.add(JSON.stringify((await sql(db, 'select deck from card_hands where id = $1', [st.hand.id])).rows[0].deck))
    }
    expect(decks.size).toBeGreaterThan(5)
  })
})

describe('베팅 검증 (서버)', () => {
  it('내 차례가 아니면 거부', async () => {
    const s = await setupMatch(db, 'A')
    const { st, other } = await actor(s)
    await expect(act(other, st.hand.id, 'check')).rejects.toThrow(/NOT_YOUR_TURN/)
  })

  it('참가자가 아니면 거부', async () => {
    const s = await setupMatch(db, 'A')
    const st = await state(s)
    await expect(act(newUser(), st.hand.id, 'check')).rejects.toThrow(/NOT_A_PLAYER/)
  })

  it('올린 금액이 있으면 체크 불가 / 없으면 콜 불가', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid, other } = await actor(s)
    await expect(act(uid, st.hand.id, 'call')).rejects.toThrow(/NOTHING_TO_CALL/)
    await act(uid, st.hand.id, 'bet', 1)
    await expect(act(other, st.hand.id, 'check')).rejects.toThrow(/CANNOT_CHECK/)
  })

  it('금액은 1~3칩, bet/raise 종류도 맞아야 한다', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid, other } = await actor(s)
    for (const amt of [0, 4, -2]) await expect(act(uid, st.hand.id, 'bet', amt)).rejects.toThrow(/BAD_AMOUNT/)
    await expect(act(uid, st.hand.id, 'raise', 1)).rejects.toThrow(/WRONG_ACTION/)
    await act(uid, st.hand.id, 'bet', 3)
    await expect(act(other, st.hand.id, 'bet', 1)).rejects.toThrow(/WRONG_ACTION/)
    const after = await state(s)
    expect(after.hand).toMatchObject({ pot: 5, current_bet: 3, raise_count: 1 })
    await expect(act(other, st.hand.id, 'frobnicate', 1)).rejects.toThrow(/UNKNOWN_ACTION/)
  })

  it('레이즈는 총 3회까지', async () => {
    const s = await setupMatch(db, 'A')
    let { st, uid, other } = await actor(s)
    await act(uid, st.hand.id, 'bet', 1);   [uid, other] = [other, uid]
    await act(uid, st.hand.id, 'raise', 1); [uid, other] = [other, uid]
    await act(uid, st.hand.id, 'raise', 1); [uid, other] = [other, uid]
    await expect(act(uid, st.hand.id, 'raise', 1)).rejects.toThrow(/RAISE_LIMIT/)
    const r = await state(s)
    expect(r.hand.raise_count).toBe(3)
    await act(uid, st.hand.id, 'call') // 콜은 가능 → 쇼다운
    expect((await state(s)).hand.status).toBe('finished')
  })

  it('가진 칩보다 많이 걸 수 없고, 올인 이후엔 상대가 레이즈할 수 없다', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid, other } = await actor(s)
    await sql(db, 'update card_matches set chips1 = 2, chips2 = 15 where id = $1', [s.matchId]) // 선(player1)의 남은 칩 2
    await expect(act(uid, st.hand.id, 'bet', 3)).rejects.toThrow(/BAD_AMOUNT/)
    await act(uid, st.hand.id, 'bet', 2) // 올인
    expect((await state(s)).match.chips1).toBe(0)
    await expect(act(other, st.hand.id, 'raise', 1)).rejects.toThrow(/BAD_AMOUNT/)
    await act(other, st.hand.id, 'call')
    expect((await state(s)).hand.status).toBe('finished')
  })

  it('칩이 모자라면 남은 칩 전부로 콜하고 상대 초과분은 환급된다', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid, other } = await actor(s)
    // 선이 5칩을 올린 상황을 직접 구성 (정상 플레이로는 상한 때문에 발생하지 않는 방어 경로)
    await sql(db, `update card_hands set committed1 = 6, pot = 7, turn_player_id = $2 where id = $1`, [st.hand.id, s.pb.id])
    await sql(db, 'update card_matches set chips1 = 14, chips2 = 2 where id = $1', [s.matchId])
    void uid; void other
    await act(s.ub, st.hand.id, 'call')
    const r = await state(s)
    expect(r.hand.committed1).toBe(3) // 상대 초과분 3칩 환급 (3 = 내가 낸 2 + 기본 1)
    expect(r.hand.committed2).toBe(3)
    expect(r.hand.result.pot).toBe(6) // 판돈 = 7 - 환급 3 + 콜 2
    expect(r.match.chips1 + r.match.chips2 + r.match.carry).toBe(2 + 14 + 7) // 정산 후에도 칩 총량 보존
  })

  it('다이하면 상대가 판돈을 가져가고 카드는 공개되지 않는다', async () => {
    const s = await setupMatch(db, 'B')
    const { st, uid } = await actor(s)
    await act(uid, st.hand.id, 'die')
    const r = await state(s)
    expect(r.hand.status).toBe('finished')
    expect(r.hand.result).toMatchObject({ reason: 'fold', pot: 2 })
    expect(r.hand.result.winner_id).toBe(uid === s.ua ? s.pb.id : s.pa.id)
    expect(r.match.chips1 + r.match.chips2).toBe(40)
    expect(r.match.next_hand_at).not.toBeNull()
  })

  it('끝난 판에는 더 행동할 수 없다', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid, other } = await actor(s)
    await act(uid, st.hand.id, 'die')
    await expect(act(other, st.hand.id, 'check')).rejects.toThrow(/HAND_NOT_ACTIVE/)
  })

  it('행동 로그가 상대 행동 표시용으로 남는다', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid, other } = await actor(s)
    await act(uid, st.hand.id, 'bet', 2)
    await act(other, st.hand.id, 'raise', 3)
    const r = await state(s)
    expect(r.actions.map((a: any) => [a.action, a.amount])).toEqual([['bet', 2], ['raise', 3]])
  })
})

describe('판 결과와 이월', () => {
  async function forceCards(handId: string, c1: number[], c2: number[]) {
    await sql(db, 'update card_hands set cards1 = $2, cards2 = $3 where id = $1', [handId, c1, c2])
  }

  it('페어가 합을 이기고 승자가 판돈을 가져간다', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid, other } = await actor(s)
    await forceCards(st.hand.id, uid === s.ua ? [2, 2] : [10, 9], uid === s.ua ? [10, 9] : [2, 2])
    await act(uid, st.hand.id, 'bet', 3)
    await act(other, st.hand.id, 'call')
    const r = await state(s)
    expect(r.hand.result).toMatchObject({ reason: 'showdown', winner_id: uid === s.ua ? s.pa.id : s.pb.id, pot: 8 })
    const mine = uid === s.ua ? r.match.chips1 : r.match.chips2
    expect(mine).toBe(19 - 3 + 8) // 24
  })

  it('무승부는 판돈을 나눈다', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid, other } = await actor(s)
    await forceCards(st.hand.id, [10, 5], [7, 8])
    await act(uid, st.hand.id, 'bet', 2)
    await act(other, st.hand.id, 'call')
    const r = await state(s)
    expect(r.hand.result).toMatchObject({ reason: 'tie', winner_id: null, carry: 0 })
    expect([r.match.chips1, r.match.chips2]).toEqual([20, 20]) // 각자 2칩씩 걸고 판돈 6을 반씩
  })

  it('무승부로 판돈이 홀수면 남는 1칩은 다음 판 판돈으로 이월된다', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid, other } = await actor(s)
    await sql(db, 'update card_matches set carry = 1 where id = $1', [s.matchId]) // 이월 칩이 있는 판
    await sql(db, 'update card_hands set pot = pot + 1 where id = $1', [st.hand.id])
    await forceCards(st.hand.id, [4, 4], [4, 4])
    await act(uid, st.hand.id, 'check')
    await act(other, st.hand.id, 'check')
    const r = await state(s)
    expect(r.hand.result).toMatchObject({ reason: 'tie', pot: 3, carry: 1 })
    expect([r.match.chips1, r.match.chips2, r.match.carry]).toEqual([20, 20, 1])
    // 다음 판: 이월 칩이 판돈에 합쳐진다 (칩 총량 41 → 보존)
    await skipPause(s.matchId)
    expect((await rpc(db, s.ua, 'advance_match', s.matchId)).result).toBe('started')
    const n = await state(s)
    expect(n.hand).toMatchObject({ hand_no: 2, pot: 3 })
    expect(n.match.carry).toBe(0)
    expect(n.match.chips1 + n.match.chips2 + n.hand.pot).toBe(41)
  })

  it('연출 시간(next_hand_at) 전에는 다음 판이 시작되지 않고, 선은 판마다 교대한다', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid } = await actor(s)
    await act(uid, st.hand.id, 'die')
    expect((await rpc(db, s.ua, 'advance_match', s.matchId)).result).toBe('wait')
    await skipPause(s.matchId)
    await rpc(db, s.ub, 'advance_match', s.matchId)
    expect((await rpc(db, s.ua, 'advance_match', s.matchId)).result).toBe('noop') // 멱등
    const n = await state(s)
    expect(n.hand.hand_no).toBe(2)
    expect(n.hand.turn_player_id).toBe(s.pb.id) // 2판의 선 = player2
  })

  it('기본 판돈으로 칩이 0이 되면 베팅 없이 곧바로 쇼다운', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid } = await actor(s)
    await sql(db, 'update card_matches set chips1 = 1 where id = $1', [s.matchId])
    await act(uid, st.hand.id, 'die')
    await skipPause(s.matchId)
    await rpc(db, s.ua, 'advance_match', s.matchId)
    const n = await state(s)
    expect(n.hand.status).toBe('finished')
    expect(n.hand.result.reason).toMatch(/showdown|tie/)
  })
})

describe('매치 진행/종료 — TS 규칙 엔진과 교차 검증', () => {
  it('무작위 플레이로 30매치: 칩 총량 보존, 최대 5판, 수익 정산', async () => {
    let seed = 987654321
    const rng = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
    for (let g = 0; g < 30; g++) {
      const s = await setupMatch(db, g % 2 ? 'A' : 'B')
      let guard = 0
      for (;;) {
        if (++guard > 300) throw new Error('매치가 끝나지 않음')
        const st = await state(s)
        if (st.match.status === 'finished') break
        if (st.hand.status === 'finished') {
          await skipPause(s.matchId)
          await rpc(db, s.ua, 'advance_match', s.matchId)
          continue
        }
        const b = bettingOf(st)
        // 서버 상태가 TS 규칙 엔진의 상태 모델과 일치
        expect(b.stacks[0] + b.stacks[1] + b.pot + st.match.carry).toBe(40)
        const la = legalActions(b)
        const opts: [string, number][] = [['die', 0]]
        if (la.canCheck) opts.push(['check', 0])
        if (la.canCall) opts.push(['call', 0])
        if (la.canRaise) opts.push([la.raiseKind, 1 + Math.floor(rng() * la.raiseMax)])
        const [a, amt] = opts[Math.floor(rng() * opts.length)]
        const uid = st.hand.turn_player_id === s.pa.id ? s.ua : s.ub
        await act(uid, st.hand.id, a, amt)
        // TS 가 불가능하다고 본 행동은 서버도 거부해야 한다
        if (!la.canCheck && st.hand.status === 'betting') {
          const st2 = await state(s)
          if (st2.hand.status === 'betting') {
            const u2 = st2.hand.turn_player_id === s.pa.id ? s.ua : s.ub
            const la2 = legalActions(bettingOf(st2))
            if (!la2.canCheck) await expect(act(u2, st2.hand.id, 'check')).rejects.toThrow(/CANNOT_CHECK/)
          }
        }
      }
      const fin = await state(s)
      const { chips1, chips2, hand_no, profit1, profit2 } = fin.match
      expect(hand_no).toBeLessThanOrEqual(5)
      expect(chips1 + chips2 + fin.match.carry).toBeLessThanOrEqual(40)
      expect(profit1).toBe(chips1 - 20)
      expect(profit2).toBe(chips2 - 20)
      if (fin.match.end_reason === 'bust') expect(Math.min(chips1, chips2)).toBe(0)
      else expect(hand_no).toBe(5)
      const rv = await rpc(db, s.ua, 'get_room_view', s.roomId)
      const byId = Object.fromEntries(rv.ranking.map((r: any) => [r.id, r]))
      expect(byId[s.pa.id].total_profit).toBe(profit1)
      expect(byId[s.pb.id].total_profit).toBe(profit2)
      expect(byId[s.pa.id].matches_played).toBe(1)
      const winner = chips1 === chips2 ? null : chips1 > chips2 ? s.pa.id : s.pb.id
      expect(fin.match.winner_id).toBe(winner)
      expect(byId[s.pa.id].matches_won + byId[s.pb.id].matches_won).toBe(winner ? 1 : 0)
      expect(byId[s.pa.id].status).toBe('idle')
    }
  })

  it('다음 매치는 다시 20칩으로 시작하고 수익이 누적된다', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid } = await actor(s)
    await act(uid, st.hand.id, 'die') // 1판 다이
    await rpc(db, s.ua, 'leave_match', s.matchId)
    const q1 = await rpc(db, s.ua, 'queue_match', s.roomId)
    expect(q1.status).toBe('queued')
    const q2 = await rpc(db, s.ub, 'queue_match', s.roomId)
    const st2 = await rpc(db, s.ub, 'get_match_state', q2.match_id)
    expect(st2.match).toMatchObject({ chips1: 19, chips2: 19, hand_no: 1 })
    expect(q2.match_id).not.toBe(s.matchId)
  })
})

describe('시간 초과 / 이탈', () => {
  it('턴 20초가 지나면 체크 가능할 땐 자동 체크', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid } = await actor(s)
    expect((await rpc(db, s.ub, 'timeout_check', st.hand.id)).result).toBe('noop') // 아직 시간 전
    await sql(db, `update card_hands set turn_deadline = now() - interval '5 seconds' where id = $1`, [st.hand.id])
    // 이미 만료된 턴에는 클라이언트 행동 대신 timeout_check 를 거쳐야 한다
    await expect(act(uid, st.hand.id, 'check')).rejects.toThrow(/TURN_EXPIRED/)
    const r = await rpc(db, s.ub, 'timeout_check', st.hand.id) // 상대 클라이언트가 호출해도 된다
    expect(r).toEqual({ result: 'auto', action: 'check' })
    const after = await state(s)
    expect(after.actions[0]).toMatchObject({ action: 'check', auto: true })
    expect(after.hand.turn_player_id).not.toBe(st.hand.turn_player_id)
    expect((await rpc(db, s.ub, 'timeout_check', st.hand.id)).result).toBe('noop') // 멱등
  })

  it('올린 금액에 응답하지 않으면 자동 다이', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid } = await actor(s)
    await act(uid, st.hand.id, 'bet', 2)
    await sql(db, `update card_hands set turn_deadline = now() - interval '2 seconds' where id = $1`, [st.hand.id])
    expect(await rpc(db, s.ua, 'timeout_check', st.hand.id)).toEqual({ result: 'auto', action: 'die' })
    const r = await state(s)
    expect(r.hand.result).toMatchObject({ reason: 'fold', pot: 4 })
    expect(r.hand.result.winner_id).toBe(uid === s.ua ? s.pa.id : s.pb.id)
  })

  it('상대가 60초 넘게 응답이 없으면 남은 사람의 승리 (기권자는 수익을 챙기지 못함)', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid, other } = await actor(s)
    await act(uid, st.hand.id, 'bet', 3) // 차례는 other 에게
    const otherPlayer = other === s.ua ? s.pa.id : s.pb.id
    await sql(db, `update card_players set last_seen = now() - interval '61 seconds' where id = $1`, [otherPlayer])
    await sql(db, `update card_hands set turn_deadline = now() - interval '2 seconds' where id = $1`, [st.hand.id])
    expect((await rpc(db, uid, 'timeout_check', st.hand.id)).result).toBe('forfeit')
    const r = await state(s)
    expect(r.match).toMatchObject({ status: 'finished', end_reason: 'forfeit' })
    expect(r.match.winner_id).toBe(uid === s.ua ? s.pa.id : s.pb.id)
    const winnerProfit = uid === s.ua ? r.match.profit1 : r.match.profit2
    const loserProfit = uid === s.ua ? r.match.profit2 : r.match.profit1
    expect(winnerProfit).toBe(19 - 3 + 5 - 20) // 진행 중이던 판돈(2+3=5)을 가져간다 = +1
    expect(loserProfit).toBeLessThanOrEqual(0)
  })

  it('판 사이 연출 중에 상대가 사라져도 기권 처리된다', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid } = await actor(s)
    await act(uid, st.hand.id, 'die')
    await sql(db, `update card_players set last_seen = now() - interval '2 minutes' where id = $1`, [uid === s.ua ? s.pa.id : s.pb.id])
    const other = uid === s.ua ? s.ub : s.ua
    expect((await rpc(db, other, 'advance_match', s.matchId)).result).toBe('forfeit')
    expect((await state(s)).match.status).toBe('finished')
  })

  it('나가기(leave_match)는 기권: 남은 사람이 승리하고 둘 다 대기 상태가 풀린다', async () => {
    const s = await setupMatch(db, 'B')
    await rpc(db, s.ua, 'leave_match', s.matchId)
    const r = await state(s)
    expect(r.match).toMatchObject({ status: 'finished', end_reason: 'forfeit', winner_id: s.pb.id })
    expect((await rpc(db, s.ub, 'my_status', s.roomId)).match_id).toBeNull()
    await rpc(db, s.ua, 'leave_match', s.matchId) // 끝난 매치에 다시 호출해도 안전
    const rv = await rpc(db, s.ub, 'get_room_view', s.roomId)
    expect(rv.ranking[0].nickname).toBe('비이')
  })
})

describe('랭킹', () => {
  it('누적 수익 ↓ → 승리 매치 수 ↓ → 먼저 참여한 순', async () => {
    const owner = newUser()
    const { room_id } = await rpc(db, owner, 'create_room', '랭킹', 'A')
    const names = ['가', '나', '다', '라']
    const ps: any[] = []
    for (const n of names) {
      ps.push(await rpc(db, newUser(), 'join_room', room_id, n))
      await sql(db, `select pg_sleep(0.01)`)
    }
    await sql(db, `update card_players set total_profit = 5, matches_won = 1 where id = $1`, [ps[3].id]) // 라
    await sql(db, `update card_players set total_profit = 5, matches_won = 2 where id = $1`, [ps[2].id]) // 다
    await sql(db, `update card_players set total_profit = 5, matches_won = 2 where id = $1`, [ps[1].id]) // 나 (다보다 먼저 참여)
    await sql(db, `update card_players set total_profit = 9, matches_won = 0 where id = $1`, [ps[0].id]) // 가
    const rv = await rpc(db, newUser(), 'get_room_view', room_id)
    expect(rv.ranking.map((r: any) => r.nickname)).toEqual(['가', '나', '다', '라'])
    expect(rv.ranking.map((r: any) => r.rank)).toEqual([1, 2, 3, 4])
  })
})

describe('방 관리', () => {
  it('생성자(관리 토큰)만 방을 종료할 수 있다', async () => {
    const s = await setupMatch(db, 'A')
    await expect(rpc(db, s.owner, 'close_room', s.roomId, 'wrong-token')).rejects.toThrow(/FORBIDDEN/)
    await expect(rpc(db, s.ua, 'close_room', s.roomId, '')).rejects.toThrow(/FORBIDDEN/)
    expect(await rpc(db, s.ua, 'verify_admin', s.roomId, s.adminToken)).toBe(true)
    expect(await rpc(db, s.ua, 'verify_admin', s.roomId, 'nope')).toBe(false)
    expect((await rpc(db, s.owner, 'get_room_view', s.roomId)).room.status).toBe('open')
  })

  it('종료하면 진행 중 매치는 무효(수익 미반영), 최종 순위 확정, 이후 입장/매칭/행동 불가', async () => {
    const s = await setupMatch(db, 'A')
    const { st, uid } = await actor(s)
    await act(uid, st.hand.id, 'bet', 2)
    // 이미 끝난 다른 매치로 수익을 만들어 둔다
    await sql(db, `update card_players set total_profit = 7, matches_won = 1 where id = $1`, [s.pb.id])

    await rpc(db, s.owner, 'close_room', s.roomId, s.adminToken)
    const rv = await rpc(db, s.ua, 'get_room_view', s.roomId)
    expect(rv.room.status).toBe('closed')
    expect(rv.active_matches).toBe(0)
    expect(rv.ranking[0]).toMatchObject({ nickname: '비이', total_profit: 7, rank: 1 })
    expect(rv.ranking.find((r: any) => r.nickname === '에이').total_profit).toBe(0) // 무효 매치는 반영 안 됨
    const fin = await sql(db, `select nickname, final_rank from card_players where room_id = $1 order by final_rank`, [s.roomId])
    expect(fin.rows.map((r: any) => r.final_rank)).toEqual([1, 2])

    const after = await state(s)
    expect(after.match.status).toBe('void')
    expect(after.hand.status).toBe('void')
    await expect(act(uid, st.hand.id, 'call')).rejects.toThrow(/HAND_NOT_ACTIVE/)
    await expect(rpc(db, s.ua, 'queue_match', s.roomId)).rejects.toThrow(/ROOM_CLOSED/)
    await expect(rpc(db, newUser(), 'join_room', s.roomId, '지각생')).rejects.toThrow(/ROOM_CLOSED/)
    expect((await rpc(db, s.ua, 'my_status', s.roomId)).match_id).toBeNull()
  })
})
