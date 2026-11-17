-- 0018: 공개 방 목록에 오래된 방도 보이게 (6시간 → 7일)
-- 이미 배포된 DB 에서 한 번 실행하세요. card_list_open_rooms 함수 하나만 create or replace 합니다(card_ 객체만).
-- 테이블/데이터는 바뀌지 않고, 기존 가위바위보 객체는 건드리지 않습니다.

create or replace function public.card_list_open_rooms()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', t.id, 'title', t.title, 'mode', t.mode, 'hard', t.hard, 'seotda', t.seotda, 'created_at', t.created_at,
             'participants', t.participants, 'active_matches', t.active_matches, 'waiting_tables', t.waiting_tables)
           order by t.waiting_tables desc, t.active_matches desc, t.created_at desc)
      from (
        select r.id, r.title, card_game.room_mode(r.id) as mode, r.created_at,
               coalesce((select o.hard from card_room_options o where o.room_id = r.id), false) as hard,
               exists (select 1 from card_room_seotda z where z.room_id = r.id) as seotda,
               (select count(*) from card_players p where p.room_id = r.id) as participants,
               (select count(*) from card_matches m where m.room_id = r.id and m.status = 'playing') as active_matches,
               (select count(*) from card_matches m where m.room_id = r.id and m.status = 'waiting') as waiting_tables
          from card_rooms r join card_public_rooms pr on pr.room_id = r.id
         where r.status = 'open'
           and (r.created_at > now() - interval '7 days'
                or exists (select 1 from card_players p where p.room_id = r.id and p.last_seen > now() - interval '7 days'))
         order by r.created_at desc
         limit 30
      ) t
  ), '[]'::jsonb);
end $$;

revoke all on function public.card_list_open_rooms() from public, anon, authenticated;
grant execute on function public.card_list_open_rooms() to authenticated;
