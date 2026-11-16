import { beforeAll, describe, expect, it } from 'vitest'
import { createDb, newUser, rpc, setupMatch, setupWaiting, sql, type Db } from './harness'

let db: Db
beforeAll(async () => {
  db = await createDb()
})

describe('닉네임 변경', () => {
  it('바꾸면 랭킹·대기 테이블·채팅에 새 이름이 보인다', async () => {
    const w = await setupWaiting(db, 'A', 2)
    const r = await rpc(db, w.users[0], 'rename_player', w.roomId, '  새이름  ')
    expect(r.nickname).toBe('새이름')
    const view = await rpc(db, w.users[1], 'get_room_view', w.roomId)
    expect(view.ranking.map((x: any) => x.nickname)).toContain('새이름')
    const st = await rpc(db, w.users[1], 'get_match_state', w.matchId)
    expect(st.seats.map((s: any) => s.nickname)).toContain('새이름')
    await rpc(db, w.users[0], 'send_chat', w.matchId, '안녕')
    expect((await rpc(db, w.users[1], 'get_chat', w.matchId, 0)).messages[0].nickname).toBe('새이름')
  })

  it('이미 쓰는 이름(대소문자 무시)이나 잘못된 길이는 거부, 자기 이름으로는 가능', async () => {
    const w = await setupWaiting(db, 'A', 2)
    await expect(rpc(db, w.users[0], 'rename_player', w.roomId, '대기2')).rejects.toThrow(/NICKNAME_TAKEN/)
    await rpc(db, w.users[0], 'rename_player', w.roomId, 'Abc')
    await expect(rpc(db, w.users[1], 'rename_player', w.roomId, 'aBC')).rejects.toThrow(/NICKNAME_TAKEN/)
    for (const bad of ['', '   ', '열세글자열세글자열세글자열']) await expect(rpc(db, w.users[0], 'rename_player', w.roomId, bad)).rejects.toThrow(/BAD_NICKNAME/)
    await rpc(db, w.users[0], 'rename_player', w.roomId, 'abc') // 내 이름의 대소문자만 바꾸기
  })

  it('대결이 진행 중일 때는 바꿀 수 없고, 끝나면 다시 가능', async () => {
    const t = await setupMatch(db, 'A', 2)
    await expect(rpc(db, t.ua, 'rename_player', t.roomId, '몰래')).rejects.toThrow(/IN_MATCH/)
    await sql(db, "update card_matches set status = 'finished' where id = $1", [t.matchId])
    expect((await rpc(db, t.ua, 'rename_player', t.roomId, '끝난뒤')).nickname).toBe('끝난뒤')
  })

  it('입장하지 않은 사람, 없는 방, 종료된 방은 거부', async () => {
    const t = await setupWaiting(db, 'A', 2)
    await expect(rpc(db, newUser(), 'rename_player', t.roomId, 'x')).rejects.toThrow(/NOT_JOINED/)
    await expect(rpc(db, t.users[0], 'rename_player', '00000000-0000-0000-0000-000000000000', 'x')).rejects.toThrow(/ROOM_NOT_FOUND/)
    await sql(db, "update card_rooms set status = 'closed' where id = $1", [t.roomId])
    await expect(rpc(db, t.users[0], 'rename_player', t.roomId, 'x')).rejects.toThrow(/ROOM_CLOSED/)
  })
})
