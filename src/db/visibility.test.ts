import { beforeAll, describe, expect, it } from 'vitest'
import { asClient, createDb, newUser, rpc, setupMatch, sql, type Db } from './harness'

let db: Db
beforeAll(async () => {
  db = await createDb()
})

/** 서버(superuser)만 아는 정답 카드 */
async function truth(handId: string) {
  const r = await sql(db, 'select cards1, cards2, open1, open2 from card_hands where id = $1', [handId])
  return r.rows[0] as { cards1: number[]; cards2: number[]; open1: number; open2: number }
}

describe('get_visible_hand — A 모드(반공개)', () => {
  it('내 카드 2장 + 상대 공개 카드 1장만 보인다 (양쪽 모두)', async () => {
    const s = await setupMatch(db, 'A')
    const st = await rpc(db, s.ua, 'get_match_state', s.matchId)
    const t = await truth(st.hand.id)

    const va = await rpc(db, s.ua, 'get_visible_hand', s.matchId) // player1
    expect(va.mode).toBe('A')
    expect(va.revealed).toBe(false)
    expect(va.me).toEqual(t.cards1)
    const expectedOppForA = [t.open2 === 1 ? t.cards2[0] : null, t.open2 === 2 ? t.cards2[1] : null]
    expect(va.opp).toEqual(expectedOppForA)
    expect(va.opp.filter((x: unknown) => x !== null)).toHaveLength(1)
    expect(va.opp_open).toBe(t.open2)
    expect(va.me_open).toBe(t.open1)

    const vb = await rpc(db, s.ub, 'get_visible_hand', s.matchId) // player2
    expect(vb.me).toEqual(t.cards2)
    expect(vb.opp).toEqual([t.open1 === 1 ? t.cards1[0] : null, t.open1 === 2 ? t.cards1[1] : null])
    expect(vb.opp.filter((x: unknown) => x !== null)).toHaveLength(1)
  })

  it('응답 JSON 어디에도 상대의 비공개 카드 값이 위치 정보와 함께 실리지 않는다 (50판 반복)', async () => {
    for (let i = 0; i < 50; i++) {
      const s = await setupMatch(db, 'A')
      const st = await rpc(db, s.ua, 'get_match_state', s.matchId)
      const t = await truth(st.hand.id)
      const v = await rpc(db, s.ua, 'get_visible_hand', s.matchId)
      const hiddenIdx = t.open2 === 1 ? 1 : 0 // 상대의 비공개 카드 위치
      expect(v.opp[hiddenIdx]).toBeNull()
      expect(Object.keys(v).sort()).toEqual(['hand_id', 'hand_no', 'me', 'me_open', 'mode', 'opp', 'opp_open', 'revealed', 'seat'])
    }
  })
})

describe('get_visible_hand — B 모드(눈치)', () => {
  it('상대 카드 2장만 보이고 내 카드는 null', async () => {
    const s = await setupMatch(db, 'B')
    const st = await rpc(db, s.ua, 'get_match_state', s.matchId)
    const t = await truth(st.hand.id)

    const va = await rpc(db, s.ua, 'get_visible_hand', s.matchId)
    expect(va.mode).toBe('B')
    expect(va.me).toEqual([null, null])
    expect(va.opp).toEqual(t.cards2)
    expect(va.me_open).toBeNull()
    expect(va.opp_open).toBeNull()

    const vb = await rpc(db, s.ub, 'get_visible_hand', s.matchId)
    expect(vb.me).toEqual([null, null])
    expect(vb.opp).toEqual(t.cards1)
  })
})

describe('공개 시점', () => {
  async function playToEnd(s: Awaited<ReturnType<typeof setupMatch>>, how: 'showdown' | 'fold') {
    const st = await rpc(db, s.ua, 'get_match_state', s.matchId)
    const first = st.hand.turn_player_id === s.pa.id ? s.ua : s.ub
    const second = first === s.ua ? s.ub : s.ua
    if (how === 'fold') {
      await rpc(db, first, 'act', st.hand.id, 'die', 0)
    } else {
      await rpc(db, first, 'act', st.hand.id, 'check', 0)
      await rpc(db, second, 'act', st.hand.id, 'check', 0)
    }
    return st.hand.id as string
  }

  for (const mode of ['A', 'B'] as const) {
    it(`${mode} 모드: 쇼다운이면 양쪽 카드가 모두 공개된다`, async () => {
      const s = await setupMatch(db, mode)
      const handId = await playToEnd(s, 'showdown')
      const t = await truth(handId)
      for (const u of [s.ua, s.ub]) {
        const v = await rpc(db, u, 'get_visible_hand', s.matchId)
        expect(v.revealed).toBe(true)
        const mine = u === s.ua ? t.cards1 : t.cards2
        const theirs = u === s.ua ? t.cards2 : t.cards1
        expect(v.me).toEqual(mine)
        expect(v.opp).toEqual(theirs)
      }
    })

    it(`${mode} 모드: 다이로 끝나면 카드를 공개하지 않는다`, async () => {
      const s = await setupMatch(db, mode)
      const handId = await playToEnd(s, 'fold')
      const t = await truth(handId)
      const va = await rpc(db, s.ua, 'get_visible_hand', s.matchId, 1)
      expect(va.revealed).toBe(false)
      if (mode === 'B') {
        expect(va.me).toEqual([null, null])
      } else {
        expect(va.opp.filter((x: unknown) => x !== null)).toHaveLength(1)
        expect(va.opp).toContain(null)
      }
      // 상대의 비공개 카드는 여전히 안 보인다 (A 모드)
      if (mode === 'A') {
        const hiddenIdx = t.open2 === 1 ? 1 : 0
        expect(va.opp[hiddenIdx]).toBeNull()
      }
    })
  }

  it('참가자가 아니면 조회 불가', async () => {
    const s = await setupMatch(db, 'A')
    await expect(rpc(db, newUser(), 'get_visible_hand', s.matchId)).rejects.toThrow(/NOT_A_PLAYER/)
    await expect(rpc(db, newUser(), 'get_match_state', s.matchId)).rejects.toThrow(/NOT_A_PLAYER/)
  })

  it('로그인하지 않은(anon) 호출은 거부', async () => {
    const s = await setupMatch(db, 'A')
    await expect(rpc(db, null, 'get_visible_hand', s.matchId)).rejects.toThrow(/permission denied/)
  })
})

describe('카드가 새어 나갈 수 있는 경로 차단', () => {
  it('hands 테이블은 어떤 컬럼도 직접 SELECT 할 수 없다', async () => {
    const s = await setupMatch(db, 'A')
    for (const q of [
      'select * from card_hands',
      'select deck from card_hands',
      'select cards1 from card_hands',
      'select cards2 from card_hands',
      'select id from card_hands',
    ]) {
      await expect(asClient(db, s.ua, q)).rejects.toThrow(/permission denied/)
    }
  })

  it('다른 테이블도 직접 읽기/쓰기 불가 (rooms, players, matches, actions)', async () => {
    const s = await setupMatch(db, 'A')
    for (const q of [
      'select * from card_rooms', 'select admin_token_hash from card_rooms', 'select * from card_players',
      'select * from card_matches', 'select * from card_actions',
      `insert into card_players (room_id, uid, nickname) values ('${s.roomId}', '${newUser()}', 'x')`,
      `update card_players set total_profit = 999 where id = '${s.pa.id}'`,
      `update card_matches set chips1 = 99 where id = '${s.matchId}'`,
      `update card_hands set cards1 = array[10,10]`,
      `delete from card_hands`,
      `update card_rooms set status = 'closed'`,
    ]) {
      await expect(asClient(db, s.ua, q)).rejects.toThrow(/permission denied/)
    }
    // 값이 바뀌지 않았다
    const r = await sql(db, 'select total_profit from card_players where id = $1', [s.pa.id])
    expect(r.rows[0].total_profit).toBe(0)
  })

  it('anon 역할은 테이블에도 함수에도 접근 불가', async () => {
    await expect(asClient(db, null, 'select * from card_rooms')).rejects.toThrow(/permission denied/)
    await expect(asClient(db, null, `select public.card_create_room('x','A')`)).rejects.toThrow(/permission denied/)
  })

  it('내부 game 스키마 함수는 클라이언트가 호출할 수 없다', async () => {
    const s = await setupMatch(db, 'A')
    await expect(asClient(db, s.ua, `select card_game.start_hand('${s.matchId}')`)).rejects.toThrow(/permission denied/)
    await expect(asClient(db, s.ua, `select card_game.settle_hand('${s.matchId}', null, true, 'x')`)).rejects.toThrow(/permission denied/)
  })

  it('get_match_state / get_room_view / my_status 응답에 카드·덱·uid·admin 해시가 없다', async () => {
    const s = await setupMatch(db, 'A')
    const outs = [
      await rpc(db, s.ua, 'get_match_state', s.matchId),
      await rpc(db, s.ua, 'get_room_view', s.roomId),
      await rpc(db, s.ua, 'my_status', s.roomId),
      await rpc(db, s.ua, 'join_room', s.roomId, '에이'),
    ]
    for (const o of outs) {
      const text = JSON.stringify(o)
      expect(text).not.toMatch(/cards|deck|admin_token|"uid"|open1|open2/)
    }
  })

  it('Realtime 신호에는 카드·칩 값이 없고 "바뀌었다"는 신호만 있다', async () => {
    const s = await setupMatch(db, 'A')
    const st = await rpc(db, s.ua, 'get_match_state', s.matchId)
    const first = st.hand.turn_player_id === s.pa.id ? s.ua : s.ub
    await rpc(db, first, 'act', st.hand.id, 'bet', 2)
    const sent = await sql(db, `select topic, event, payload from realtime.sent where topic like '%' || $1 || '%'`, [s.matchId])
    expect(sent.rows.length).toBeGreaterThan(0)
    for (const row of sent.rows) {
      expect(row.event).toBe('changed')
      expect(Object.keys(row.payload)).toEqual(['ts'])
    }
  })

  it('admin_token 은 해시로만 저장된다', async () => {
    const s = await setupMatch(db, 'A')
    const r = await sql(db, 'select admin_token_hash from card_rooms where id = $1', [s.roomId])
    expect(r.rows[0].admin_token_hash).not.toBe(s.adminToken)
    expect(r.rows[0].admin_token_hash).toMatch(/^[0-9a-f]{64}$/)
  })
})
