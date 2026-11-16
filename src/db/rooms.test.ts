import { beforeAll, describe, expect, it } from 'vitest'
import { asClient, createDb, newUser, rpc, sql, type Db } from './harness'

let db: Db
beforeAll(async () => {
  db = await createDb()
})

const listIds = async (u = newUser()) => (await rpc(db, u, 'list_open_rooms')).map((r: any) => r.id)

describe('공개 방 목록', () => {
  it('공개로 바꾼 방만 보이고, 기본은 비공개', async () => {
    const owner = newUser()
    const priv = await rpc(db, owner, 'create_room', '비공개방', 'A')
    const pub = await rpc(db, owner, 'create_room_ex', '공개방', 'B', true)
    expect(await listIds()).not.toContain(priv.room_id)
    expect(await listIds()).not.toContain(pub.room_id)
    await rpc(db, owner, 'set_room_public', pub.room_id, pub.admin_token, true)
    const rows = await rpc(db, newUser(), 'list_open_rooms')
    const row = rows.find((r: any) => r.id === pub.room_id)
    expect(row).toMatchObject({ title: '공개방', mode: 'B', hard: true, participants: 0, active_matches: 0, waiting_tables: 0 })
    expect(rows.map((r: any) => r.id)).not.toContain(priv.room_id)
  })

  it('관리 토큰이 맞아야 바꿀 수 있고, 다시 비공개로 돌릴 수 있다', async () => {
    const owner = newUser()
    const room = await rpc(db, owner, 'create_room', '토글방', 'A')
    await expect(rpc(db, newUser(), 'set_room_public', room.room_id, 'wrong', true)).rejects.toThrow(/FORBIDDEN/)
    await rpc(db, owner, 'set_room_public', room.room_id, room.admin_token, true)
    expect(await listIds()).toContain(room.room_id)
    expect((await rpc(db, owner, 'get_room_view', room.room_id)).room.public).toBe(true)
    await rpc(db, owner, 'set_room_public', room.room_id, room.admin_token, false)
    expect(await listIds()).not.toContain(room.room_id)
    expect((await rpc(db, owner, 'get_room_view', room.room_id)).room.public).toBe(false)
  })

  it('종료된 방·오래 방치된 방은 목록에서 빠지고, 참가자/테이블 수가 보인다', async () => {
    const owner = newUser()
    const a = await rpc(db, owner, 'create_room', '활발한방', 'A')
    const b = await rpc(db, owner, 'create_room', '끝난방', 'A')
    const c = await rpc(db, owner, 'create_room', '오래된방', 'A')
    for (const r of [a, b, c]) await rpc(db, owner, 'set_room_public', r.room_id, r.admin_token, true)
    const u = newUser()
    await rpc(db, u, 'join_room', a.room_id, '손님')
    await rpc(db, u, 'queue_match', a.room_id)
    await rpc(db, owner, 'close_room', b.room_id, b.admin_token)
    await sql(db, "update card_rooms set created_at = now() - interval '7 hours' where id = $1", [c.room_id])

    const rows = await rpc(db, newUser(), 'list_open_rooms')
    const ids = rows.map((r: any) => r.id)
    expect(ids).toContain(a.room_id)
    expect(ids).not.toContain(b.room_id)
    expect(ids).not.toContain(c.room_id)
    expect(rows.find((r: any) => r.id === a.room_id)).toMatchObject({ participants: 1, waiting_tables: 1 })
  })

  it('uid·관리 토큰은 내보내지 않고, 테이블은 직접 읽을 수 없다', async () => {
    const owner = newUser()
    const room = await rpc(db, owner, 'create_room', '비밀검사', 'A')
    await rpc(db, owner, 'set_room_public', room.room_id, room.admin_token, true)
    const json = JSON.stringify(await rpc(db, newUser(), 'list_open_rooms'))
    expect(json).not.toMatch(/admin|uid|token/)
    await expect(asClient(db, owner, 'select * from public.card_public_rooms')).rejects.toThrow()
    await expect(rpc(db, null, 'list_open_rooms')).rejects.toThrow()
  })

  it('목록은 최대 30개', async () => {
    const owner = newUser()
    for (let i = 0; i < 33; i++) {
      const r = await rpc(db, owner, 'create_room', `방${i}`, 'A')
      await rpc(db, owner, 'set_room_public', r.room_id, r.admin_token, true)
    }
    expect((await rpc(db, newUser(), 'list_open_rooms')).length).toBeLessThanOrEqual(30)
  })
})
