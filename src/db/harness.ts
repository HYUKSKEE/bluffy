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

/** 방 + 두 플레이어 + 매치 시작. player1 = 먼저 대기한 사람(a). */
export async function setupMatch(db: Db, mode: 'A' | 'B') {
  const owner = newUser(), ua = newUser(), ub = newUser()
  const room = await rpc(db, owner, 'create_room', '테스트방', mode)
  const roomId: string = room.room_id
  const pa = await rpc(db, ua, 'join_room', roomId, '에이')
  const pb = await rpc(db, ub, 'join_room', roomId, '비이')
  const q1 = await rpc(db, ua, 'queue_match', roomId)
  const q2 = await rpc(db, ub, 'queue_match', roomId)
  const matchId: string = q2.match_id
  return { owner, ua, ub, pa, pb, roomId, adminToken: room.admin_token as string, matchId, q1, q2 }
}

/** 서버측(superuser) 조작: 시간 흐름 흉내, 정답 카드 확인 등 */
export const sql = (db: Db, q: string, p: unknown[] = []) => db.query<any>(q, p as any[])
