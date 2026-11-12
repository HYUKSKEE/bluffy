import { beforeAll, describe, expect, it } from 'vitest'
import { createDb, newUser, rpc, setupMatch, setupWaiting, sql, type Db } from './harness'

let db: Db
beforeAll(async () => {
  db = await createDb()
})

async function joinSpectator(roomId: string, nick = '구경꾼') {
  const u = newUser()
  await rpc(db, u, 'join_room', roomId, nick)
  return u
}

describe.each(['A', 'B'] as const)('관전 — %s 모드', (mode) => {
  it('진행 중인 판의 카드 값은 관전자에게 어떤 형태로도 가지 않는다', async () => {
    const t = await setupMatch(db, mode, 3)
    const spec = await joinSpectator(t.roomId)
    const st = await rpc(db, spec, 'spectate_match', t.matchId)

    expect(st.my_seat).toBeNull()
    expect(st.hand.status).toBe('betting')
    expect(st.seats).toHaveLength(3)
    expect(st.revealed_cards).toEqual([])

    // 정답 카드 값이 응답 문자열 어디에도 "cards" 로 실려 오지 않는다
    const json = JSON.stringify(st)
    expect(json).not.toMatch(/"cards"/)
    expect(json).not.toMatch(/open_idx/)
    expect(json).not.toMatch(/deck/)
  })

  it('쇼다운으로 공개된 뒤에는 생존자 카드만 보인다', async () => {
    const t = await setupMatch(db, mode, 3)
    const spec = await joinSpectator(t.roomId)
    // 전원 체크 → 쇼다운
    for (;;) {
      const st = await rpc(db, t.ua, 'get_match_state', t.matchId)
      if (st.hand.status === 'finished') break
      await rpc(db, t.users[st.hand.turn_seat - 1], 'act', st.hand.id, 'check', 0)
    }
    const st = await rpc(db, spec, 'spectate_match', t.matchId)
    expect(st.hand.revealed).toBe(true)
    expect(st.revealed_cards).toHaveLength(3)
    const truth = await sql(db, 'select seat, cards from card_hand_seats where hand_id = $1 order by seat', [st.hand.id])
    for (const row of st.revealed_cards) {
      expect(row.cards).toEqual(truth.rows.find((x: any) => x.seat === row.seat).cards)
    }
  })

  it('다이로 끝난 판(공개 안 됨)은 카드가 나오지 않는다', async () => {
    const t = await setupMatch(db, mode, 2)
    const spec = await joinSpectator(t.roomId)
    const st0 = await rpc(db, t.ua, 'get_match_state', t.matchId)
    await rpc(db, t.users[st0.hand.turn_seat - 1], 'act', st0.hand.id, 'die', 0)
    const st = await rpc(db, spec, 'spectate_match', t.matchId)
    expect(st.hand.status).toBe('finished')
    expect(st.hand.revealed).toBe(false)
    expect(st.revealed_cards).toEqual([])
    expect(JSON.stringify(st)).not.toMatch(/"cards"/)
  })
})

describe('관전 — 권한', () => {
  it('방에 입장하지 않은 사람은 볼 수 없다', async () => {
    const t = await setupMatch(db, 'A', 2)
    await expect(rpc(db, newUser(), 'spectate_match', t.matchId)).rejects.toThrow(/NOT_JOINED/)
    await expect(rpc(db, newUser(), 'list_tables', t.roomId)).rejects.toThrow(/NOT_JOINED/)
  })

  it('다른 방 사람은 볼 수 없다', async () => {
    const t = await setupMatch(db, 'A', 2)
    const other = await setupMatch(db, 'A', 2)
    await expect(rpc(db, other.ua, 'spectate_match', t.matchId)).rejects.toThrow(/NOT_JOINED/)
  })

  it('관전자는 행동·시작·나가기를 할 수 없다', async () => {
    const t = await setupMatch(db, 'A', 2)
    const spec = await joinSpectator(t.roomId)
    const st = await rpc(db, spec, 'spectate_match', t.matchId)
    await expect(rpc(db, spec, 'act', st.hand.id, 'check', 0)).rejects.toThrow()
    await expect(rpc(db, spec, 'get_visible_hand', t.matchId, null)).rejects.toThrow(/NOT_A_PLAYER/)
    await expect(rpc(db, spec, 'get_match_state', t.matchId)).rejects.toThrow(/NOT_A_PLAYER/)
  })

  it('없는 매치', async () => {
    const t = await setupMatch(db, 'A', 2)
    const spec = await joinSpectator(t.roomId)
    await expect(rpc(db, spec, 'spectate_match', '00000000-0000-0000-0000-000000000000')).rejects.toThrow(/MATCH_NOT_FOUND/)
  })
})

describe('테이블 목록', () => {
  it('대기 중/진행 중 테이블만, 끝난 테이블은 제외', async () => {
    const w = await setupWaiting(db, 'A', 2)
    const spec = await joinSpectator(w.roomId)
    let list = await rpc(db, spec, 'list_tables', w.roomId)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ status: 'waiting', seats: 2, max_hands: 10 })
    expect(list[0].players).toHaveLength(2)

    await rpc(db, w.users[0], 'start_match', w.matchId)
    list = await rpc(db, spec, 'list_tables', w.roomId)
    expect(list[0].status).toBe('playing')

    await sql(db, "update card_matches set status = 'finished' where id = $1", [w.matchId])
    list = await rpc(db, spec, 'list_tables', w.roomId)
    expect(list).toEqual([])
  })
})
