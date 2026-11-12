/**
 * 테스트용 Postgres(PGlite) 하네스.
 * Supabase 가 제공하는 것(역할 anon/authenticated, auth.uid(), realtime.send, 기본 권한)을 흉내 내고
 * supabase/migrations/*.sql 을 그대로 실행한다.
 */
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  create schema realtime;
  create table realtime.sent (topic text, event text, payload jsonb);
  create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
    returns void language sql as $$ insert into realtime.sent values (topic, event, payload) $$;
  -- Supabase 의 기본 권한(새 테이블/함수는 anon, authenticated 에 열림)을 재현:
  -- 마이그레이션이 제대로 회수하는지 검증하기 위함
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
`

export async function createDb(legacySql = '') {
  const db = new PGlite()
  await db.exec(SUPABASE_STUB)
  if (legacySql) await db.exec(legacySql) // 마이그레이션 이전부터 있던 다른 게임의 객체
  const dir = join(process.cwd(), 'supabase', 'migrations')
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(dir, f), 'utf8'))
  }
  return db
}
export type Db = Awaited<ReturnType<typeof createDb>>

export const newUser = () => randomUUID()

async function becomeClient(db: Db, uid: string | null) {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ''])
  await db.exec(uid ? 'set role authenticated' : 'set role anon')
}

/** 특정 사용자(authenticated)로 RPC 호출. uid=null 이면 anon(로그인 안 함). */
export async function rpc<T = any>(db: Db, uid: string | null, fn: string, ...args: unknown[]): Promise<T> {
  await becomeClient(db, uid)
  try {
    const ph = args.map((_, i) => `$${i + 1}`).join(', ')
    const r = await db.query<{ r: T }>(`select public.card_${fn}(${ph}) as r`, args as any[])
    return r.rows[0].r
  } finally {
    await db.exec('reset role')
  }
}

/** 클라이언트 역할로 임의 SQL 실행 (권한 테스트용) */
export async function asClient(db: Db, uid: string | null, q: string) {
  await becomeClient(db, uid)
  try {
    return await db.query<any>(q)
  } finally {
    await db.exec('reset role')
  }
}

export interface Table {
  owner: string
  roomId: string
  adminToken: string
  matchId: string
  /** 좌석 순서(1번 좌석 = 방장)의 사용자 uid / 플레이어 정보 */
  users: string[]
  players: any[]
  /** 방장 + 첫 상대 (2인 테스트용 단축) */
  ua: string
  ub: string
  pa: any
  pb: any
}

/** 방 + n명 입장 + 테이블 시작 (n<5 면 방장이 시작, 5명이면 자동 시작). 1번 좌석 = 방장. */
export async function setupMatch(db: Db, mode: 'A' | 'B', n = 2): Promise<Table> {
  const owner = newUser()
  const room = await rpc(db, owner, 'create_room', '테스트방', mode)
  const roomId: string = room.room_id
  const users: string[] = []
  const players: any[] = []
  let matchId = ''
  for (let i = 0; i < n; i++) {
    const u = newUser()
    users.push(u)
    players.push(await rpc(db, u, 'join_room', roomId, `선수${i + 1}`))
    const q = await rpc(db, u, 'queue_match', roomId)
    matchId = q.match_id
  }
  if (n < 5) await rpc(db, users[0], 'start_match', matchId)
  return { owner, roomId, adminToken: room.admin_token as string, matchId, users, players, ua: users[0], ub: users[1], pa: players[0], pb: players[1] }
}

/** 방 + 대기 테이블만 만든다 (시작 전) */
export async function setupWaiting(db: Db, mode: 'A' | 'B', n: number) {
  const owner = newUser()
  const room = await rpc(db, owner, 'create_room', '대기방', mode)
  const users: string[] = []
  const players: any[] = []
  let matchId = ''
  for (let i = 0; i < n; i++) {
    const u = newUser()
    users.push(u)
    players.push(await rpc(db, u, 'join_room', room.room_id, `대기${i + 1}`))
    matchId = (await rpc(db, u, 'queue_match', room.room_id)).match_id
  }
  return { owner, roomId: room.room_id as string, users, players, matchId }
}

/** 서버측(superuser) 조작: 시간 흐름 흉내, 정답 카드 확인 등 */
export const sql = (db: Db, q: string, p: unknown[] = []) => db.query<any>(q, p as any[])
