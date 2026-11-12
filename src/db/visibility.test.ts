import { beforeAll, describe, expect, it } from 'vitest'
import { asClient, createDb, newUser, rpc, setupMatch, sql, type Db, type Table } from './harness'

let db: Db
beforeAll(async () => {
  db = await createDb()
})

/** 서버(superuser)만 아는 정답 카드: seat → { cards, open_idx } */
async function truth(handId: string) {
  const r = await sql(db, 'select seat, cards, open_idx, folded from card_hand_seats where hand_id = $1 order by seat', [handId])
  return Object.fromEntries(r.rows.map((x: any) => [x.seat, x])) as Record<number, { cards: number[]; open_idx: number; folded: boolean }>
}
const state = (t: Table) => rpc(db, t.ua, 'get_match_state', t.matchId)
const view = (t: Table, seat: number, handNo?: number) => rpc(db, t.users[seat - 1], 'get_visible_hand', t.matchId, handNo ?? null)
const seatOf = (v: any, seat: number) => v.seats.find((x: any) => x.seat === seat)

/** 현재 차례인 사람 */
async function turnUser(t: Table) {
  const st = await state(t)
  return { st, uid: t.users[st.hand.turn_seat - 1], seat: st.hand.turn_seat as number }
}
/** 전원 체크로 쇼다운 */
async function allCheck(t: Table) {
  for (;;) {
    const { st, uid } = await turnUser(t)
    await rpc(db, uid, 'act', st.hand.id, 'check', 0)
    if ((await state(t)).hand.status === 'finished') return st.hand.id as string
  }
}

describe.each([2, 3, 5])('A 모드(반공개) — %i명', (n) => {
  it('내 카드 2장 + 각 상대의 공개 카드 1장만 보인다 (모든 좌석 시점)', async () => {
    const t = await setupMatch(db, 'A', n)
    const st = await state(t)
    const tr = await truth(st.hand.id)
    for (let me = 1; me <= n; me++) {
      const v = await view(t, me)
      expect(v.mode).toBe('A')
      expect(v.revealed).toBe(false)
      expect(v.my_seat).toBe(me)
      expect(v.seats).toHaveLength(n)
      for (let s = 1; s <= n; s++) {
        const row = seatOf(v, s)
        expect(row.open).toBe(tr[s].open_idx)
        if (s === me) {
          expect(row.cards).toEqual(tr[s].cards)
        } else {
          const expected = [tr[s].open_idx === 1 ? tr[s].cards[0] : null, tr[s].open_idx === 2 ? tr[s].cards[1] : null]
          expect(row.cards).toEqual(expected)
          expect(row.cards.filter((c: unknown) => c !== null)).toHaveLength(1)
        }
      }
    }
  })
})

describe.each([2, 3, 5])('B 모드(눈치) — %i명', (n) => {
  it('모든 상대의 카드 2장만 보이고 내 카드는 null', async () => {
    const t = await setupMatch(db, 'B', n)
    const st = await state(t)
    const tr = await truth(st.hand.id)
    for (let me = 1; me <= n; me++) {
      const v = await view(t, me)
      expect(v.mode).toBe('B')
      expect(seatOf(v, me).cards).toEqual([null, null])
      expect(seatOf(v, me).open).toBeNull()
      for (let s = 1; s <= n; s++) if (s !== me) expect(seatOf(v, s).cards).toEqual(tr[s].cards)
    }
  })
})

describe('응답에 숨긴 카드가 실리지 않는다', () => {
  it('A 모드 50판 반복: 상대의 비공개 카드 위치는 항상 null', async () => {
    for (let i = 0; i < 50; i++) {
      const t = await setupMatch(db, 'A', 3)
      const st = await state(t)
      const tr = await truth(st.hand.id)
      const v = await view(t, 1)
      for (const s of [2, 3]) {
        const hiddenIdx = tr[s].open_idx === 1 ? 1 : 0
        expect(seatOf(v, s).cards[hiddenIdx]).toBeNull()
      }
      expect(Object.keys(v).sort()).toEqual(['hand_id', 'hand_no', 'mode', 'my_seat', 'revealed', 'seats'])
    }
  })
})

describe('공개 시점', () => {
  for (const mode of ['A', 'B'] as const) {
    it(`${mode} 모드: 쇼다운이면 생존자의 카드가 모두에게 공개된다`, async () => {
      const t = await setupMatch(db, mode, 3)
      const handId = await allCheck(t)
      const tr = await truth(handId)
      for (let me = 1; me <= 3; me++) {
        const v = await view(t, me)
        expect(v.revealed).toBe(true)
        for (let s = 1; s <= 3; s++) expect(seatOf(v, s).cards).toEqual(tr[s].cards)
      }
    })

    it(`${mode} 모드: 다이로 끝나면 카드를 공개하지 않는다`, async () => {
      const t = await setupMatch(db, mode, 3)
      const st = await state(t)
      const handId = st.hand.id
      for (let i = 0; i < 2; i++) {
        const { uid } = await turnUser(t)
        await rpc(db, uid, 'act', handId, 'die', 0)
      }
      expect((await state(t)).hand.status).toBe('finished')
      const tr = await truth(handId)
      const v = await view(t, 1, 1)
      expect(v.revealed).toBe(false)
      if (mode === 'B') {
        expect(seatOf(v, 1).cards).toEqual([null, null])
      } else {
        for (const s of [2, 3]) {
          const hiddenIdx = tr[s].open_idx === 1 ? 1 : 0
          expect(seatOf(v, s).cards[hiddenIdx]).toBeNull()
        }
      }
    })
  }

  it('A 모드: 쇼다운이어도 다이한 사람의 비공개 카드는 공개되지 않는다', async () => {
    const t = await setupMatch(db, 'A', 3)
    const st = await state(t)
    const { uid: first, seat: s1 } = await turnUser(t)
    await rpc(db, first, 'act', st.hand.id, 'bet', 1)
    const { uid: second, seat: s2 } = await turnUser(t)
    await rpc(db, second, 'act', st.hand.id, 'die', 0)
    const { uid: third } = await turnUser(t)
    await rpc(db, third, 'act', st.hand.id, 'call', 0) // 쇼다운 (s1 과 survivor 생존)
    expect((await state(t)).hand.revealed).toBe(true)
    const tr = await truth(st.hand.id)
    const v = await view(t, s1)
    const hiddenIdx = tr[s2].open_idx === 1 ? 1 : 0
    expect(seatOf(v, s2).cards[hiddenIdx]).toBeNull() // 다이한 s2 의 비공개 카드는 그대로 숨김
    expect(seatOf(v, s2).cards.filter((c: unknown) => c !== null)).toHaveLength(1)
    const survivor = [1, 2, 3].find((x) => x !== s1 && x !== s2)!
    expect(seatOf(v, survivor).cards).toEqual(tr[survivor].cards) // 생존자는 전부 공개
  })

  it('참가자가 아니면 조회 불가', async () => {
    const t = await setupMatch(db, 'A', 3)
    await expect(rpc(db, newUser(), 'get_visible_hand', t.matchId)).rejects.toThrow(/NOT_A_PLAYER/)
    await expect(rpc(db, newUser(), 'get_match_state', t.matchId)).rejects.toThrow(/NOT_A_PLAYER/)
  })

  it('로그인하지 않은(anon) 호출은 거부', async () => {
    const t = await setupMatch(db, 'A')
    await expect(rpc(db, null, 'get_visible_hand', t.matchId)).rejects.toThrow(/permission denied/)
  })
})

describe('카드가 새어 나갈 수 있는 경로 차단', () => {
  it('card_hands / card_hand_seats 는 어떤 컬럼도 직접 SELECT 할 수 없다', async () => {
    const t = await setupMatch(db, 'A', 3)
    for (const q of [
      'select * from card_hands', 'select deck from card_hands', 'select id from card_hands',
      'select * from card_hand_seats', 'select cards from card_hand_seats', 'select open_idx from card_hand_seats',
      'select seat from card_hand_seats',
    ]) {
      await expect(asClient(db, t.ua, q)).rejects.toThrow(/permission denied/)
    }
  })

  it('다른 테이블도 직접 읽기/쓰기 불가', async () => {
    const t = await setupMatch(db, 'A', 3)
    for (const q of [
      'select * from card_rooms', 'select admin_token_hash from card_rooms', 'select * from card_players',
      'select * from card_matches', 'select * from card_match_players', 'select * from card_actions',
      `insert into card_players (room_id, uid, nickname) values ('${t.roomId}', '${newUser()}', 'x')`,
      `update card_players set total_profit = 999 where id = '${t.pa.id}'`,
      `update card_match_players set chips = 9999`,
      `update card_matches set host_player_id = '${t.pb.id}'`,
      `update card_hand_seats set cards = array[10,10]`,
      `delete from card_hands`,
      `update card_rooms set status = 'closed'`,
    ]) {
      await expect(asClient(db, t.ua, q)).rejects.toThrow(/permission denied/)
    }
    const r = await sql(db, 'select total_profit from card_players where id = $1', [t.pa.id])
    expect(r.rows[0].total_profit).toBe(0)
  })

  it('anon 역할은 테이블에도 함수에도 접근 불가', async () => {
    await expect(asClient(db, null, 'select * from card_rooms')).rejects.toThrow(/permission denied/)
    await expect(asClient(db, null, `select public.card_create_room('x','A')`)).rejects.toThrow(/permission denied/)
  })

  it('내부 card_game 스키마 함수는 클라이언트가 호출할 수 없다', async () => {
    const t = await setupMatch(db, 'A')
    await expect(asClient(db, t.ua, `select card_game.start_hand('${t.matchId}')`)).rejects.toThrow(/permission denied/)
    await expect(asClient(db, t.ua, `select card_game.settle_fold('${t.matchId}', 1)`)).rejects.toThrow(/permission denied/)
  })

  it('card_get_match_state / room_view / my_status 응답에 카드·덱·uid·admin 해시가 없다', async () => {
    const t = await setupMatch(db, 'A', 3)
    const outs = [
      await rpc(db, t.ua, 'get_match_state', t.matchId),
      await rpc(db, t.ua, 'get_room_view', t.roomId),
      await rpc(db, t.ua, 'my_status', t.roomId),
      await rpc(db, t.ua, 'join_room', t.roomId, '선수1'),
    ]
    for (const o of outs) expect(JSON.stringify(o)).not.toMatch(/cards|deck|admin_token|"uid"|open_idx|"open":/)
  })

  it('Realtime 신호에는 카드·칩 값이 없고 "바뀌었다"는 신호만 있다 (card_ 토픽)', async () => {
    const t = await setupMatch(db, 'A', 3)
    const { st, uid } = await turnUser(t)
    await rpc(db, uid, 'act', st.hand.id, 'bet', 2)
    const sent = await sql(db, `select topic, event, payload from realtime.sent`)
    expect(sent.rows.length).toBeGreaterThan(0)
    for (const row of sent.rows) {
      expect(row.topic).toMatch(/^card_(room|match):/)
      expect(row.event).toBe('changed')
      expect(Object.keys(row.payload)).toEqual(['ts'])
    }
  })

  it('admin_token 은 해시로만 저장된다', async () => {
    const t = await setupMatch(db, 'A')
    const r = await sql(db, 'select admin_token_hash from card_rooms where id = $1', [t.roomId])
    expect(r.rows[0].admin_token_hash).not.toBe(t.adminToken)
    expect(r.rows[0].admin_token_hash).toMatch(/^[0-9a-f]{64}$/)
  })
})
