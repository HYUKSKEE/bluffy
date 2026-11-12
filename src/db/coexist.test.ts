import { describe, expect, it } from 'vitest'
import { createDb, sql } from './harness'

/** 같은 Supabase 프로젝트의 다른 게임(가위바위보)과 공존: 기존 객체를 건드리지 않고, 이름도 충돌하지 않는다. */
const LEGACY = `
  create table public.rooms (id uuid primary key default gen_random_uuid(), title text);
  create table public.players (id uuid primary key default gen_random_uuid(), nickname text);
  create table public.matches (id uuid primary key default gen_random_uuid(), score int default 0);
  create table public.hands (id uuid primary key default gen_random_uuid(), pick text);
  create table public.actions (id bigserial primary key, note text);
  create function public.create_room(p_title text) returns uuid language sql as $$ select gen_random_uuid() $$;
  create function public.act(p_x int) returns int language sql as $$ select p_x + 1 $$;
  create function public.heartbeat() returns int language sql as $$ select 42 $$;
  create schema game;
  create function game.start_hand() returns int language sql as $$ select 7 $$;
  insert into public.rooms (title) values ('rps-room');
`

describe('다른 게임과 공존', () => {
  it('기존 테이블·함수·스키마가 그대로이고 권한도 바뀌지 않는다', async () => {
    const db = await createDb(LEGACY)
    // 기존 데이터 유지
    expect((await sql(db, 'select title from public.rooms')).rows).toEqual([{ title: 'rps-room' }])
    // 기존 함수가 같은 시그니처 그대로 동작
    expect((await sql(db, 'select public.act(1) as v, public.heartbeat() as h, game.start_hand() as g')).rows[0]).toEqual({ v: 2, h: 42, g: 7 })
    // 기존 테이블의 anon/authenticated 권한이 회수되지 않았다
    const g = await sql(db, `select has_table_privilege('anon','public.rooms','select') a, has_table_privilege('authenticated','public.players','insert') b,
      has_function_privilege('anon','public.act(int)','execute') c, has_function_privilege('authenticated','public.create_room(text)','execute') d,
      has_sequence_privilege('anon','public.actions_id_seq','usage') e`)
    expect(g.rows[0]).toEqual({ a: true, b: true, c: true, d: true, e: true })
    // 기존 테이블 구조가 변하지 않았다
    const cols = await sql(db, `select column_name from information_schema.columns where table_schema='public' and table_name='rooms' order by 1`)
    expect(cols.rows.map((r: any) => r.column_name)).toEqual(['id', 'title'])
  })

  it('이 프로젝트가 만든 객체는 전부 card_ 접두어를 쓴다', async () => {
    const db = await createDb(LEGACY)
    const t = await sql(db, `select table_name from information_schema.tables where table_schema='public' and table_name like 'card\\_%' order by 1`)
    expect(t.rows.map((r: any) => r.table_name)).toEqual(['card_actions', 'card_hands', 'card_matches', 'card_players', 'card_rooms'])
    const ours = await sql(db, `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname not like 'card\\_%' and proname not in ('act','heartbeat','create_room') and proname not like 'gen\\_%'`)
    expect(ours.rows).toEqual([]) // 접두어 없는 새 함수가 없다
    const idx = await sql(db, `select indexname from pg_indexes where schemaname='public' and tablename like 'card\\_%' and indexname not like 'card\\_%'`)
    expect(idx.rows.filter((r: any) => !/_pkey$|_key$/.test(r.indexname))).toEqual([])
  })

  it('접두어 없는 이름의 마이그레이션 SQL 이 없다 (DROP/ALTER/기존 객체 변경 금지)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const dir = 'supabase/migrations/'
    for (const f of readdirSync(dir)) {
      const text = readFileSync(dir + f, 'utf8').replace(/--.*$/gm, '')
      expect(text, f).not.toMatch(/\bdrop\s/i)
      expect(text, f).not.toMatch(/\bor\s+replace\b/i)
      expect(text, f).not.toMatch(/all\s+(functions|sequences|tables)\s+in\s+schema\s+public/i)
      expect(text, f).not.toMatch(/alter\s+(default\s+privileges|table\s+public\.(?!card_))/i)
    }
  })
})
