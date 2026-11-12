import { beforeAll, describe, expect, it } from 'vitest'
import { createDb, newUser, rpc, sql, type Db } from './harness'

let db: Db
beforeAll(async () => {
  db = await createDb()
})

/** 고난이도(또는 일반) 방 + n명 입장 + 시작 */
async function setup(n: number, hard: boolean, mode: 'A' | 'B' = 'A') {
  const owner = newUser()
  const room = await rpc(db, owner, 'create_room_ex', '덱방', mode, hard)
  const users: string[] = []
  let matchId = ''
  for (let i = 0; i < n; i++) {
    const u = newUser()
    users.push(u)
    await rpc(db, u, 'join_room', room.room_id, `선수${i + 1}`)
    matchId = (await rpc(db, u, 'queue_match', room.room_id)).match_id
  }
  if (n < 5) await rpc(db, users[0], 'start_match', matchId)
  return { roomId: room.room_id as string, users, matchId }
}
type T = Awaited<ReturnType<typeof setup>>

const state = (t: T) => rpc(db, t.users[0], 'get_match_state', t.matchId)

/** 현재 판을 다이로 끝내고 다음 판을 시작한다 */
async function nextHand(t: T) {
  for (;;) {
    const st = await state(t)
    if (st.hand.status === 'finished') break
    await rpc(db, t.users[st.hand.turn_seat - 1], 'act', st.hand.id, 'die', 0)
  }
  await sql(db, `update card_matches set next_hand_at = now() - interval '1 second' where id = $1`, [t.matchId])
  await rpc(db, t.users[0], 'advance_match', t.matchId)
  return state(t)
}
const dealt = async (handId: string) =>
  (await sql(db, 'select cards from card_hand_seats where hand_id = $1', [handId])).rows.flatMap((r: any) => r.cards as number[])

describe('고난이도 모드 — 설정', () => {
  it('일반 방은 pile.hard=false, 고난이도 방은 room.hard=true', async () => {
    const a = await setup(2, false)
    expect((await state(a)).pile).toEqual({ hard: false })
    expect((await rpc(db, a.users[0], 'get_room_view', a.roomId)).room.hard).toBe(false)
    const b = await setup(2, true)
    expect((await rpc(db, b.users[0], 'get_room_view', b.roomId)).room.hard).toBe(true)
    expect((await state(b)).pile.hard).toBe(true)
  })

  it('card_create_room(기존 2인자)은 일반 방', async () => {
    const r = await rpc(db, newUser(), 'create_room', '그냥', 'A')
    const u = newUser()
    await rpc(db, u, 'join_room', r.room_id, '혼자')
    expect((await rpc(db, u, 'get_room_view', r.room_id)).room.hard).toBe(false)
  })

  it.each([[2, 2], [3, 2], [4, 3], [5, 3]])('%i명이면 %i세트(인원×2장×3라운드÷10 올림)', async (n, sets) => {
    const t = await setup(n, true)
    const st = await state(t)
    expect(st.pile).toMatchObject({ hard: true, sets, total: sets * 10, shuffle_no: 1, fresh: true, marker_out: false })
    expect(st.pile.remaining).toBe(sets * 10 - 2 * n)
  })
})

describe('고난이도 모드 — 덱 순환', () => {
  it('셔플 없이 덱을 이어서 쓰고, 예고 카드가 나온 판 다음에 셔플한다 (2명, 2세트)', async () => {
    const t = await setup(2, true)
    const seen: number[] = []
    let st = await state(t)
    seen.push(...(await dealt(st.hand.id)))
    expect(st.pile).toMatchObject({ remaining: 16, fresh: true, shuffle_no: 1, marker_out: false })

    // 2~4판: 셔플 없음, 남은 장수가 4장씩 줄어든다
    for (const remaining of [12, 8, 4]) {
      st = await nextHand(t)
      seen.push(...(await dealt(st.hand.id)))
      expect(st.pile).toMatchObject({ remaining, fresh: false, shuffle_no: 1, marker_out: false })
    }
    // 이 시점까지 나눠 준 16장은 모두 서로 다른 덱에서 나왔다 (한 세트는 1~10 각 2장)
    for (let v = 1; v <= 10; v++) expect(seen.filter((x) => x === v).length).toBeLessThanOrEqual(2)

    // 5판: 아래에서 1라운드 분량 위치의 셔플 예고 카드가 나온다 → 이번 판이 끝나면 셔플
    st = await nextHand(t)
    seen.push(...(await dealt(st.hand.id)))
    expect(st.pile).toMatchObject({ remaining: 0, fresh: false, shuffle_no: 1, marker_out: true })
    // 20장을 모두 한 번씩만 썼다 → 1~10 각 정확히 2장
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10])

    // 6판: 리셋(재셔플) — "셔플 중" 표시, 새 덱
    st = await nextHand(t)
    expect(st.pile).toMatchObject({ remaining: 16, fresh: true, shuffle_no: 2, marker_out: false })
    // 7판: 표시 해제
    st = await nextHand(t)
    expect(st.pile).toMatchObject({ remaining: 12, fresh: false, shuffle_no: 2 })
  })

  it('남은 카드가 모두에게 나눠 줄 만큼 부족하면 예고 카드가 없어도 리셋한다', async () => {
    const t = await setup(3, true) // 3명 → 6장 필요
    await sql(db, 'update card_match_decks set deck = $2 where match_id = $1', [t.matchId, [5, 5, 7]])
    const st = await nextHand(t)
    expect(st.pile).toMatchObject({ fresh: true, shuffle_no: 2, remaining: 14 }) // 20장 - 6장
  })

  it('리셋하면 예고 카드는 다시 아래에서 1라운드 분량 위치에 들어간다', async () => {
    const t = await setup(3, true)
    await sql(db, 'update card_match_decks set deck = $2 where match_id = $1', [t.matchId, [1]])
    await nextHand(t)
    const d = (await sql(db, 'select deck from card_match_decks where match_id = $1', [t.matchId])).rows[0].deck as number[]
    // 새 덱 20장 + 예고 1장 - 나눠 준 6장 = 15, 예고 카드(0)는 맨 아래에서 6장 위
    expect(d).toHaveLength(15)
    expect(d.indexOf(0)).toBe(d.length - 1 - 6) // 예고 카드 아래에 6장(= 3명 × 2장)
    expect(d.filter((x) => x === 0)).toHaveLength(1)
  })

  it('A/B 모드 모두 동작하고, 카드 값은 응답에 새지 않는다', async () => {
    for (const mode of ['A', 'B'] as const) {
      const t = await setup(2, true, mode)
      const st = await state(t)
      expect(Object.keys(st.pile).sort()).toEqual(['fresh', 'hard', 'marker_out', 'remaining', 'sets', 'shuffle_no', 'total'])
      expect(JSON.stringify(st)).not.toMatch(/"cards"|deck/)
    }
  })

  it('관전 응답에도 같은 덱 정보가 있다', async () => {
    const t = await setup(2, true)
    const spec = newUser()
    await rpc(db, spec, 'join_room', t.roomId, '구경')
    const sp = await rpc(db, spec, 'spectate_match', t.matchId)
    expect(sp.pile).toEqual((await state(t)).pile)
  })

  it('클라이언트는 덱 테이블을 직접 읽을 수 없다', async () => {
    const t = await setup(2, true)
    const { asClient } = await import('./harness')
    await expect(asClient(db, t.users[0], 'select * from public.card_match_decks')).rejects.toThrow()
    await expect(asClient(db, t.users[0], 'select * from public.card_room_options')).rejects.toThrow()
  })
})

describe('수동 패치 SQL', () => {
  it('patch_0005/0006 을 이미 반영된 DB 에 다시 실행해도 오류 없이 동작한다', async () => {
    const { readFileSync } = await import('node:fs')
    await db.exec(readFileSync('supabase/patch_0005_ante_reveal.sql', 'utf8'))
    await db.exec(readFileSync('supabase/patch_0006_hard_mode.sql', 'utf8'))
    const t = await setup(2, true)
    expect((await state(t)).pile).toMatchObject({ hard: true, sets: 2, remaining: 16 })
    const st = await nextHand(t)
    expect(st.pile.remaining).toBe(12)
  })
})
