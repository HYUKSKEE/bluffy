-- ⚠️ 수동 패치 (마이그레이션 아님): 공개 방 목록. 이미 0001~0004 를 실행한 DB 에서 한 번 실행하세요
-- (patch_0006 의 card_get_room_view 교체본이 먼저 적용되어 있어야 합니다).
-- 새로 0001~0004 를 실행하는 경우에는 필요 없습니다 (이미 반영되어 있음).
--
-- 변경: 새 테이블 card_public_rooms, 새 함수 card_set_room_public / card_list_open_rooms,
--       교체 함수 1개(card_get_room_view: room.public 추가). card_ 객체만 만들거나 교체한다.

create table if not exists public.card_public_rooms (
  room_id uuid primary key references public.card_rooms(id) on delete cascade
);

alter table public.card_public_rooms enable row level security;
revoke all on public.card_public_rooms from public;
revoke all on public.card_public_rooms from anon, authenticated;

create or replace function public.card_set_room_public(p_room_id uuid, p_admin_token text, p_public boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.card_verify_admin(p_room_id, p_admin_token) then raise exception 'FORBIDDEN'; end if;
  if coalesce(p_public, false) then
    insert into card_public_rooms (room_id) values (p_room_id) on conflict do nothing;
  else
    delete from card_public_rooms where room_id = p_room_id;
  end if;
  perform card_game.notify('card_room:' || p_room_id);
  return jsonb_build_object('public', coalesce(p_public, false));
end $$;

create or replace function public.card_list_open_rooms()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', t.id, 'title', t.title, 'mode', t.mode, 'hard', t.hard, 'created_at', t.created_at,
             'participants', t.participants, 'active_matches', t.active_matches, 'waiting_tables', t.waiting_tables)
           order by t.waiting_tables desc, t.active_matches desc, t.created_at desc)
      from (
        select r.id, r.title, r.mode, r.created_at,
               coalesce((select o.hard from card_room_options o where o.room_id = r.id), false) as hard,
               (select count(*) from card_players p where p.room_id = r.id) as participants,
               (select count(*) from card_matches m where m.room_id = r.id and m.status = 'playing') as active_matches,
               (select count(*) from card_matches m where m.room_id = r.id and m.status = 'waiting') as waiting_tables
          from card_rooms r join card_public_rooms pr on pr.room_id = r.id
         where r.status = 'open'
           and (r.created_at > now() - interval '6 hours'
                or exists (select 1 from card_players p where p.room_id = r.id and p.last_seen > now() - interval '6 hours'))
         order by r.created_at desc
         limit 30
      ) t
  ), '[]'::jsonb);
end $$;

create or replace function public.card_get_room_view(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r card_rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into r from card_rooms where id = p_room_id;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  return jsonb_build_object(
    'room', jsonb_build_object('id', r.id, 'title', r.title, 'mode', r.mode, 'status', r.status,
                               'created_at', r.created_at, 'closed_at', r.closed_at,
                               'hard', coalesce((select o.hard from card_room_options o where o.room_id = r.id), false),
                               'public', exists (select 1 from card_public_rooms pr where pr.room_id = r.id)),
    'participants', (select count(*) from card_players where room_id = r.id),
    'active_matches', (select count(*) from card_matches where room_id = r.id and status = 'playing'),
    'waiting_tables', (select count(*) from card_matches where room_id = r.id and status = 'waiting'),
    'ranking', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'nickname', p.nickname, 'total_profit', p.total_profit,
               'matches_played', p.matches_played, 'matches_won', p.matches_won,
               'joined_at', p.joined_at, 'rank', p.rn,
               'status', case when p.status = 'queued' and p.last_seen < now() - interval '30 seconds'
                              then 'idle' else p.status end)
             order by p.rn)
      from (select pl.*, row_number() over (order by pl.total_profit desc, pl.matches_won desc, pl.joined_at asc, pl.id) as rn
              from card_players pl where pl.room_id = r.id) p
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.card_set_room_public(uuid, text, boolean), public.card_list_open_rooms() from public, anon, authenticated;
grant execute on function public.card_set_room_public(uuid, text, boolean), public.card_list_open_rooms() to authenticated;
