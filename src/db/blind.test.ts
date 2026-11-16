import { beforeAll, describe, expect, it } from 'vitest'
import { createDb, newUser, rpc, sql, type Db } from './harness'

let db: Db
beforeAll(async () => {
  db = await createDb()
})

async function setupBlind(n: number) {
  const owner = newUser()
  const room = await rpc(db, owner, 'create_room', 'C방', 'B')
  await rpc(db, owner, 'set_room_blind', room.room_id, room.admin_token, true)
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

describe('C 모드 (블라인드)', () => {
  it('방 설정: 관리 토큰 필요, 대결이 만들어진 뒤에는 변경 불가, mode 가 C 로 보인다', async () => {
    const owner = newUser()
    const room = await rpc(db, owner, 'create_room', 'x', 'B')
    await expect(rpc(db, newUser(), 'set_room_blind', room.room_id, 'wrong', true)).rejects.toThrow(/FORBIDDEN/)
    expect((await rpc(db, owner, 'get_room_view', room.room_id)).room.mode).toBe('B')
    await rpc(db, owner, 'set_room_blind', room.room_id, room.admin_token, true)
    expect((await rpc(db, owner, 'get_room_view', room.room_id)).room.mode).toBe('C')
    await rpc(db, owner, 'set_room_blind', room.room_id, room.admin_token, false)
    expect((await rpc(db, owner, 'get_room_view', room.room_id)).room.mode).toBe('B')
    await rpc(db, owner, 'set_room_blind', room.room_id, room.admin_token, true)
    const u = newUser()
    await rpc(db, u, 'join_room', room.room_id, '손님')
    await rpc(db, u, 'queue_match', room.room_id)
    await expect(rpc(db, owner, 'set_room_blind', room.room_id, room.admin_token, false)).rejects.toThrow(/ROOM_IN_USE/)
  })

  it('판이 끝나기 전에는 누구에게도 카드가 보이지 않는다 (내 카드도, 상대 카드도)', async () => {
    for (const n of [2, 3, 5]) {
      const t = await setupBlind(n)
      const st = await rpc(db, t.users[0], 'get_match_state', t.matchId)
      expect(st.match.mode).toBe('C')
      for (let me = 1; me <= n; me++) {
        const v = await rpc(db, t.users[me - 1], 'get_visible_hand', t.matchId, null)
        expect(v.mode).toBe('C')
        expect(v.revealed).toBe(false)
        for (const s of v.seats) {
          expect(s.cards, `viewer ${me} seat ${s.seat}`).toEqual([null, null])
          expect(s.open).toBeNull()
        }
      }
    }
  })

  it('쇼다운이 되면 끝까지 남은 사람끼리 패를 보고, 다이한 사람은 서로 못 본다', async () => {
    const t = await setupBlind(3)
    const st = await rpc(db, t.users[0], 'get_match_state', t.matchId)
    const truth = Object.fromEntries((await sql(db, 'select seat, cards from card_hand_seats where hand_id = $1', [st.hand.id])).rows.map((r: any) => [r.seat, r.cards]))
    const first = st.hand.turn_seat as number
    await rpc(db, t.users[first - 1], 'act', st.hand.id, 'die', 0)
    for (;;) {
      const cur = await rpc(db, t.users[0], 'get_match_state', t.matchId)
      if (cur.hand.status === 'finished') break
      await rpc(db, t.users[cur.hand.turn_seat - 1], 'act', cur.hand.id, 'check', 0)
    }
    const remain = [1, 2, 3].filter((x) => x !== first)
    const rv = await rpc(db, t.users[remain[0] - 1], 'get_visible_hand', t.matchId, 1)
    expect(rv.revealed).toBe(true)
    for (const s of remain) expect(rv.seats.find((x: any) => x.seat === s).cards).toEqual(truth[s])
    expect(rv.seats.find((x: any) => x.seat === first).cards).toEqual([null, null])
    const fv = await rpc(db, t.users[first - 1], 'get_visible_hand', t.matchId, 1)
    expect(fv.seats.find((x: any) => x.seat === first).cards).toEqual(truth[first]) // 내 패는 공개
    for (const s of remain) expect(fv.seats.find((x: any) => x.seat === s).cards).toEqual([null, null])
  })

  it('관전자는 C 모드에서도 모든 카드를 본다 (mode 는 C)', async () => {
    const t = await setupBlind(2)
    const spec = newUser()
    await rpc(db, spec, 'join_room', t.room.room_id, '구경')
    const sp = await rpc(db, spec, 'spectate_match', t.matchId)
    expect(sp.match.mode).toBe('C')
    expect(sp.seat_cards).toHaveLength(2)
    for (const c of sp.seat_cards) expect(c.open).toBeNull()
  })

  it('방 목록에도 mode C 로 나온다, 클라이언트는 테이블을 직접 읽을 수 없다', async () => {
    const owner = newUser()
    const room = await rpc(db, owner, 'create_room', '목록C', 'B')
    await rpc(db, owner, 'set_room_blind', room.room_id, room.admin_token, true)
    await rpc(db, owner, 'set_room_public', room.room_id, room.admin_token, true)
    const rows = await rpc(db, newUser(), 'list_open_rooms')
    expect(rows.find((r: any) => r.id === room.room_id).mode).toBe('C')
    const { asClient } = await import('./harness')
    await expect(asClient(db, owner, 'select * from public.card_room_blind')).rejects.toThrow()
  })

  it('A/B 모드는 그대로다', async () => {
    const owner = newUser()
    const room = await rpc(db, owner, 'create_room', 'A방', 'A')
    const us = [newUser(), newUser()]
    let m = ''
    for (const [i, u] of us.entries()) {
      await rpc(db, u, 'join_room', room.room_id, `p${i}`)
      m = (await rpc(db, u, 'queue_match', room.room_id)).match_id
    }
    await rpc(db, us[0], 'start_match', m)
    const v = await rpc(db, us[0], 'get_visible_hand', m, null)
    expect(v.mode).toBe('A')
    expect(v.seats.find((s: any) => s.seat === 1).cards.every((c: unknown) => c !== null)).toBe(true) // 내 카드는 보인다
  })
})
