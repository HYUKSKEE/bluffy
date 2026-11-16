-- ⚠️ 수동 패치 (마이그레이션 아님): 채팅. patch_0005, 0006 을 먼저 실행한 DB 에서 한 번 실행하세요.
-- 새로 0001~0004 를 실행하는 경우에는 필요 없습니다 (이미 반영되어 있음).
--
-- 변경: 새 테이블 card_chat_messages, 새 함수(card_game.chat_channel, card_send_chat, card_get_chat),
--       교체 함수 1개(card_close_room: 방 종료 시 채팅 삭제). card_ 객체만 만들거나 교체한다.

create table if not exists public.card_chat_messages (
  id         bigint generated always as identity primary key,
  match_id   uuid not null references public.card_matches(id) on delete cascade,
  channel    text not null check (channel in ('table', 'spectate')),
  player_id  uuid not null references public.card_players(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 80),
  created_at timestamptz not null default now()
);
create index if not exists card_chat_match_idx on public.card_chat_messages (match_id, channel, id);

alter table public.card_chat_messages enable row level security;
revoke all on public.card_chat_messages from public;
revoke all on public.card_chat_messages from anon, authenticated;

create or replace function card_game.chat_channel(p_match uuid, p_uid uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m card_matches%rowtype;
  v_pl uuid;
  v_left boolean;
  v_seat int;
begin
  select * into m from card_matches where id = p_match;
  if not found then raise exception 'MATCH_NOT_FOUND'; end if;
  select id into v_pl from card_players where room_id = m.room_id and uid = p_uid;
  if v_pl is null then raise exception 'NOT_JOINED'; end if;
  select mp.seat, mp.left_match into v_seat, v_left from card_match_players mp where mp.match_id = p_match and mp.player_id = v_pl;
  return jsonb_build_object('player_id', v_pl, 'room_id', m.room_id,
                            'channel', case when v_seat is not null and not v_left then 'table' else 'spectate' end);
end $$;

create or replace function public.card_send_chat(p_match_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_who jsonb;
  v_body text := btrim(regexp_replace(coalesce(p_body, ''), '[[:cntrl:]]+', ' ', 'g'));
  v_id bigint;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  v_who := card_game.chat_channel(p_match_id, v_uid);
  if char_length(v_body) < 1 or char_length(v_body) > 80 then raise exception 'BAD_CHAT'; end if;
  if (select count(*) from card_chat_messages
       where match_id = p_match_id and player_id = (v_who->>'player_id')::uuid
         and created_at > now() - interval '10 seconds') >= 5 then
    raise exception 'CHAT_RATE';
  end if;

  -- 끝난 지 10분 지난 테이블의 채팅은 지운다
  delete from card_chat_messages c using card_matches x
   where c.match_id = x.id and x.room_id = (v_who->>'room_id')::uuid
     and x.status in ('finished', 'void') and coalesce(x.finished_at, x.created_at) < now() - interval '10 minutes';

  insert into card_chat_messages (match_id, channel, player_id, body)
  values (p_match_id, v_who->>'channel', (v_who->>'player_id')::uuid, v_body) returning id into v_id;
  perform card_game.notify('card_chat:' || p_match_id || ':' || (v_who->>'channel'));
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.card_get_chat(p_match_id uuid, p_after bigint default 0)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_who jsonb;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  v_who := card_game.chat_channel(p_match_id, v_uid);
  return jsonb_build_object(
    'channel', v_who->>'channel',
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'nickname', t.nickname, 'body', t.body,
                                          'created_at', t.created_at, 'mine', t.mine) order by t.id)
        from (select c.id, p.nickname, c.body, c.created_at, (c.player_id = (v_who->>'player_id')::uuid) as mine
                from card_chat_messages c join card_players p on p.id = c.player_id
               where c.match_id = p_match_id and c.channel = v_who->>'channel' and c.id > coalesce(p_after, 0)
               order by c.id desc limit 50) t
    ), '[]'::jsonb));
end $$;

create or replace function public.card_close_room(p_room_id uuid, p_admin_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_m uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.card_verify_admin(p_room_id, p_admin_token) then raise exception 'FORBIDDEN'; end if;
  perform pg_advisory_xact_lock(hashtext('card_room:' || p_room_id::text));

  update card_rooms set status = 'closed', closed_at = now() where id = p_room_id and status = 'open';

  for v_m in select id from card_matches where room_id = p_room_id and status in ('waiting', 'playing') for update loop
    update card_hands set status = 'void', turn_seat = null, turn_deadline = null
     where match_id = v_m and status = 'betting';
    update card_matches set status = 'void', end_reason = 'void', next_hand_at = null where id = v_m;
    perform card_game.notify('card_match:' || v_m);
  end loop;
  update card_players set status = 'idle', queued_at = null where room_id = p_room_id;
  delete from card_chat_messages where match_id in (select id from card_matches where room_id = p_room_id); -- 방 종료: 채팅 삭제

  update card_players p set final_rank = s.rn
    from (select id, row_number() over (order by total_profit desc, matches_won desc, joined_at asc, id) as rn
            from card_players where room_id = p_room_id) s
   where p.id = s.id;

  perform card_game.notify('card_room:' || p_room_id);
  return jsonb_build_object('ok', true);
end $$;

revoke all on function card_game.chat_channel(uuid, uuid) from public;
revoke all on function public.card_send_chat(uuid, text), public.card_get_chat(uuid, bigint) from public, anon, authenticated;
grant execute on function public.card_send_chat(uuid, text), public.card_get_chat(uuid, bigint) to authenticated;
