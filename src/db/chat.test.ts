import { beforeAll, describe, expect, it } from 'vitest'
import { asClient, createDb, newUser, rpc, setupMatch, sql, type Db } from './harness'

let db: Db
beforeAll(async () => {
  db = await createDb()
})

async function spectator(roomId: string, nick = '구경꾼') {
  const u = newUser()
  await rpc(db, u, 'join_room', roomId, nick)
  return u
}
const get = (u: string, matchId: string, after = 0) => rpc(db, u, 'get_chat', matchId, after)

describe('채팅 — 채널 분리', () => {
  it('참가자 채팅은 참가자끼리, 관전자 채팅은 관전자끼리만 보인다', async () => {
    const t = await setupMatch(db, 'A', 3)
    const s1 = await spectator(t.roomId, '관전1')
    const s2 = await spectator(t.roomId, '관전2')

    await rpc(db, t.users[0], 'send_chat', t.matchId, '이번 판 간다!')
    await rpc(db, s1, 'send_chat', t.matchId, '선수1 패 좋아요')

    const p2 = await get(t.users[1], t.matchId)
    expect(p2.channel).toBe('table')
    expect(p2.messages.map((m: any) => m.body)).toEqual(['이번 판 간다!'])

    const sp = await get(s2, t.matchId)
    expect(sp.channel).toBe('spectate')
    expect(sp.messages.map((m: any) => m.body)).toEqual(['선수1 패 좋아요'])

    // 서로의 메시지는 어떤 경로로도 보이지 않는다
    expect(JSON.stringify(p2)).not.toContain('패 좋아요')
    expect(JSON.stringify(sp)).not.toContain('간다')
  })

  it('mine 표시만 있고 uid/player_id 는 내보내지 않는다', async () => {
    const t = await setupMatch(db, 'B', 2)
    await rpc(db, t.users[0], 'send_chat', t.matchId, '안녕')
    const a = await get(t.users[0], t.matchId)
    const b = await get(t.users[1], t.matchId)
    expect(a.messages[0]).toMatchObject({ nickname: '선수1', body: '안녕', mine: true })
    expect(b.messages[0].mine).toBe(false)
    expect(JSON.stringify(a)).not.toMatch(/player_id|uid/)
  })

  it('p_after 이후 메시지만 돌려준다', async () => {
    const t = await setupMatch(db, 'A', 2)
    const r1 = await rpc(db, t.users[0], 'send_chat', t.matchId, '하나')
    await rpc(db, t.users[1], 'send_chat', t.matchId, '둘')
    const after = await get(t.users[0], t.matchId, r1.id)
    expect(after.messages.map((m: any) => m.body)).toEqual(['둘'])
  })

  it('나간 사람은 참가자 채팅을 볼 수 없다 (관전자 채널로 이동)', async () => {
    const t = await setupMatch(db, 'A', 3)
    await rpc(db, t.users[2], 'leave_match', t.matchId)
    await rpc(db, t.users[0], 'send_chat', t.matchId, '비밀 작전')
    const out = await get(t.users[2], t.matchId)
    expect(out.channel).toBe('spectate')
    expect(out.messages).toEqual([])
  })
})

describe('채팅 — 검증', () => {
  it('방에 입장하지 않았거나 다른 방 사람은 쓰기·읽기 불가', async () => {
    const t = await setupMatch(db, 'A', 2)
    const other = await setupMatch(db, 'A', 2)
    for (const u of [newUser(), other.ua]) {
      await expect(rpc(db, u, 'send_chat', t.matchId, 'hi')).rejects.toThrow(/NOT_JOINED/)
      await expect(get(u, t.matchId)).rejects.toThrow(/NOT_JOINED/)
    }
  })

  it('길이 1~80자, 공백/제어문자만은 거부, HTML 은 그대로 문자열', async () => {
    const t = await setupMatch(db, 'A', 2)
    for (const bad of ['', '   ', '\n\t', 'ㅁ'.repeat(81)]) await expect(rpc(db, t.ua, 'send_chat', t.matchId, bad)).rejects.toThrow(/BAD_CHAT/)
    await rpc(db, t.ua, 'send_chat', t.matchId, 'ㅁ'.repeat(80))
    await rpc(db, t.ua, 'send_chat', t.matchId, '<b>굵게</b>')
    const c = await get(t.ub, t.matchId)
    expect(c.messages.at(-1).body).toBe('<b>굵게</b>') // 화면에서 텍스트로만 그린다
  })

  it('도배 방지: 10초에 5개까지', async () => {
    const t = await setupMatch(db, 'A', 2)
    for (let i = 0; i < 5; i++) await rpc(db, t.ua, 'send_chat', t.matchId, `m${i}`)
    await expect(rpc(db, t.ua, 'send_chat', t.matchId, '또')).rejects.toThrow(/CHAT_RATE/)
    await rpc(db, t.ub, 'send_chat', t.matchId, '다른 사람은 가능')
    await sql(db, "update card_chat_messages set created_at = now() - interval '20 seconds' where match_id = $1", [t.matchId])
    await rpc(db, t.ua, 'send_chat', t.matchId, '이제 가능')
  })

  it('테이블을 직접 읽거나 쓸 수 없다', async () => {
    const t = await setupMatch(db, 'A', 2)
    await rpc(db, t.ua, 'send_chat', t.matchId, 'hi')
    await expect(asClient(db, t.ua, 'select * from public.card_chat_messages')).rejects.toThrow()
    await expect(asClient(db, t.ua, `insert into public.card_chat_messages (match_id, channel, player_id, body) values ('${t.matchId}', 'table', gen_random_uuid(), 'x')`)).rejects.toThrow()
  })
})

describe('채팅 — 보관 기간', () => {
  it('방이 종료되면 그 방의 채팅이 모두 삭제된다 (다른 방은 그대로)', async () => {
    const t = await setupMatch(db, 'A', 2)
    const other = await setupMatch(db, 'A', 2)
    await rpc(db, t.ua, 'send_chat', t.matchId, '지워질 말')
    await rpc(db, other.ua, 'send_chat', other.matchId, '남을 말')
    await rpc(db, t.owner, 'close_room', t.roomId, t.adminToken)
    const left = (await sql(db, 'select match_id, body from card_chat_messages')).rows.filter((r: any) => [t.matchId, other.matchId].includes(r.match_id))
    expect(left.map((r: any) => r.body)).toEqual(['남을 말'])
  })

  it('끝난 지 10분 지난 테이블의 채팅은 새 메시지를 보낼 때 정리된다', async () => {
    const old = await setupMatch(db, 'A', 2)
    await rpc(db, old.ua, 'send_chat', old.matchId, '오래된 말')
    await sql(db, "update card_matches set status = 'finished', finished_at = now() - interval '11 minutes' where id = $1", [old.matchId])
    // 같은 방에서 새 메시지를 보내면 오래된 끝난 테이블의 채팅이 정리된다
    const fresh = await rpc(db, newUser(), 'create_room', '새방', 'A')
    void fresh
    const sp = await spectator(old.roomId, '새사람')
    await rpc(db, sp, 'send_chat', old.matchId, '새 말')
    const rows = (await sql(db, 'select body from card_chat_messages where match_id = $1', [old.matchId])).rows.map((r: any) => r.body)
    expect(rows).toEqual(['새 말'])
  })
})
