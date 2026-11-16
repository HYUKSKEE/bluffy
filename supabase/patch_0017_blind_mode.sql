-- ⚠️ 수동 패치 (마이그레이션 아님): C 모드(블라인드) — 내 카드만 보이고 상대 카드는 판이 끝나기 전까지 하나도 안 보인다.
-- patch_0015(섯다)·0016 을 먼저 실행한 DB 에서 실행하세요. (이미 실행했더라도 다시 실행해도 됩니다 — 같은 함수를 다시 교체할 뿐입니다.)
-- 새로 0001~0004 를 실행하는 경우에는 필요 없습니다 (이미 반영되어 있음).
--
-- 변경: 새 테이블 card_room_blind, 새 함수 card_game.room_mode / card_set_room_blind,
--       교체 함수 5개(card_get_visible_hand, card_get_match_state, card_spectate_match, card_get_room_view, card_list_open_rooms).
-- card_ 객체만 만들거나 교체한다. 다른 게임의 객체는 건드리지 않는다.

create table if not exists public.card_room_blind (
  room_id uuid primary key references public.card_rooms(id) on delete cascade
);

alter table public.card_room_blind enable row level security;
revoke all on public.card_room_blind from public;
revoke all on public.card_room_blind from anon, authenticated;

create or replace function card_game.room_mode(p_room uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from card_room_blind b where b.room_id = p_room) then 'C'
              else (select r.mode from card_rooms r where r.id = p_room) end
$$;
revoke all on function card_game.room_mode(uuid) from public;

create or replace function public.card_get_visible_hand(p_match_id uuid, p_hand_no int default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  m card_matches%rowtype;
  h card_hands%rowtype;
  r card_rooms%rowtype;
  v_my_seat int;
  hs record;
  v_cards int[];
  v_out boolean;
  v_mode text;
  v_seats jsonb := '[]'::jsonb;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into m from card_matches where id = p_match_id;
  if not found then raise exception 'MATCH_NOT_FOUND'; end if;
  select mp.seat into v_my_seat from card_match_players mp join card_players p on p.id = mp.player_id
   where mp.match_id = p_match_id and p.uid = v_uid;
  if v_my_seat is null then raise exception 'NOT_A_PLAYER'; end if;

  select * into r from card_rooms where id = m.room_id;
  v_mode := card_game.room_mode(r.id);
  select * into h from card_hands
   where match_id = p_match_id and (p_hand_no is null or hand_no = p_hand_no)
   order by hand_no desc limit 1;
  if not found then return null; end if;

  -- 다이한 사람은 상대의 패를 볼 수 없고, 다이한 사람의 패도 상대에게 보이지 않는다 (진행 중에도, 판이 끝난 뒤에도).
  -- 끝까지 남은 사람들만 판이 끝나면 서로의 패를 본다. (본 정보를 남에게 알려주는 것 방지)
  v_out := exists (select 1 from card_hand_seats x where x.hand_id = h.id and x.seat = v_my_seat and x.folded);

  for hs in select * from card_hand_seats where hand_id = h.id order by seat loop
    if hs.seat = v_my_seat then
      -- 내 카드: 판이 끝나면 공개, 진행 중에는 모드 규칙 (A·C: 보임, B: 안 보임)
      v_cards := case when h.revealed and hs.in_hand then hs.cards
                      when v_mode in ('A', 'C') then hs.cards
                      else array[null, null]::int[] end;
    elsif v_out then
      v_cards := array[null, null]::int[];                              -- 다이한 사람: 상대 패는 끝까지 안 보인다
    elsif hs.folded then
      v_cards := array[null, null]::int[];                              -- 다이한 사람의 패는 상대에게 (진행 중에도, 끝난 뒤에도) 안 보인다
    elsif h.revealed and hs.in_hand then
      v_cards := hs.cards;                                              -- 판이 끝나면 끝까지 남은 사람들의 패를 서로 공개
    elsif v_mode = 'C' then
      v_cards := array[null, null]::int[];                              -- C 모드(블라인드): 상대 카드는 하나도 안 보인다 (공개 카드도 없음)
    elsif v_mode = 'A' then
      v_cards := array[case when hs.open_idx = 1 then hs.cards[1] end, case when hs.open_idx = 2 then hs.cards[2] end];
    else
      v_cards := hs.cards;
    end if;
    v_seats := v_seats || jsonb_build_array(jsonb_build_object(
      'seat', hs.seat, 'cards', to_jsonb(v_cards), 'open', case when v_mode = 'A' then hs.open_idx end));
  end loop;

  return jsonb_build_object('hand_id', h.id, 'hand_no', h.hand_no, 'mode', v_mode,
                            'my_seat', v_my_seat, 'revealed', h.revealed, 'seats', v_seats);
end $$;

create or replace function public.card_get_match_state(p_match_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  m card_matches%rowtype;
  h card_hands%rowtype;
  r card_rooms%rowtype;
  v_my_seat int;
  v_hand jsonb := null;
  v_hand_id uuid := null;
  v_actions jsonb := '[]'::jsonb;
  v_seats jsonb;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into m from card_matches where id = p_match_id;
  if not found then raise exception 'MATCH_NOT_FOUND'; end if;
  select mp.seat into v_my_seat from card_match_players mp join card_players p on p.id = mp.player_id
   where mp.match_id = p_match_id and p.uid = v_uid;
  if v_my_seat is null then raise exception 'NOT_A_PLAYER'; end if;
  select * into r from card_rooms where id = m.room_id;

  select * into h from card_hands where match_id = p_match_id order by hand_no desc limit 1;
  if found then
    v_hand_id := h.id;
    v_hand := jsonb_build_object(
      'id', h.id, 'hand_no', h.hand_no, 'status', h.status, 'pot', h.pot, 'level', h.level,
      'current_bet', h.current_bet, 'raise_count', h.raise_count, 'lead_seat', h.lead_seat,
      'turn_seat', h.turn_seat, 'turn_deadline', h.turn_deadline, 'revealed', h.revealed, 'result', h.result);
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', a.id, 'seat', a.seat, 'player_id', a.player_id, 'action', a.action, 'amount', a.amount,
             'auto', a.auto, 'created_at', a.created_at) order by a.id), '[]'::jsonb)
      into v_actions from card_actions a where a.hand_id = h.id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'seat', mp.seat, 'player_id', mp.player_id, 'nickname', p.nickname, 'chips', mp.chips,
           'left', mp.left_match, 'is_host', (m.host_player_id = mp.player_id),
           'profit', mp.profit, 'is_winner', mp.is_winner,
           'in_hand', coalesce(hs.in_hand, false), 'folded', coalesce(hs.folded, false),
           'committed', coalesce(hs.committed, 0)) order by mp.seat), '[]'::jsonb)
    into v_seats
    from card_match_players mp
    join card_players p on p.id = mp.player_id
    left join card_hand_seats hs on hs.hand_id = v_hand_id and hs.seat = mp.seat
   where mp.match_id = m.id;

  return jsonb_build_object(
    'server_now', now(),
    'my_seat', v_my_seat,
    'match', jsonb_build_object(
      'id', m.id, 'room_id', m.room_id, 'room_status', r.status, 'mode', card_game.room_mode(m.room_id), 'status', m.status,
      'hand_no', m.hand_no, 'max_hands', m.max_hands, 'start_chips', m.start_chips, 'carry', m.carry,
      'host_player_id', m.host_player_id, 'end_reason', m.end_reason, 'next_hand_at', m.next_hand_at,
      'seotda', exists (select 1 from card_room_seotda z where z.room_id = m.room_id)),
    'seats', v_seats,
    'hand', v_hand,
    'actions', v_actions,
    'pile', card_game.deck_info(m.id));
end $$;

create or replace function public.card_spectate_match(p_match_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  m card_matches%rowtype;
  h card_hands%rowtype;
  r card_rooms%rowtype;
  v_hand jsonb := null;
  v_hand_id uuid := null;
  v_actions jsonb := '[]'::jsonb;
  v_seats jsonb;
  v_cards jsonb := '[]'::jsonb;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into m from card_matches where id = p_match_id;
  if not found then raise exception 'MATCH_NOT_FOUND'; end if;
  -- 같은 방에 닉네임을 등록한 사람만 볼 수 있다
  perform 1 from card_players where room_id = m.room_id and uid = v_uid;
  if not found then raise exception 'NOT_JOINED'; end if;
  select * into r from card_rooms where id = m.room_id;

  select * into h from card_hands where match_id = p_match_id order by hand_no desc limit 1;
  if found then
    v_hand_id := h.id;
    v_hand := jsonb_build_object(
      'id', h.id, 'hand_no', h.hand_no, 'status', h.status, 'pot', h.pot, 'level', h.level,
      'current_bet', h.current_bet, 'raise_count', h.raise_count, 'lead_seat', h.lead_seat,
      'turn_seat', h.turn_seat, 'turn_deadline', h.turn_deadline, 'revealed', h.revealed, 'result', h.result);
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', a.id, 'seat', a.seat, 'player_id', a.player_id, 'action', a.action, 'amount', a.amount,
             'auto', a.auto, 'created_at', a.created_at) order by a.id), '[]'::jsonb)
      into v_actions from card_actions a where a.hand_id = h.id;
    select coalesce(jsonb_agg(jsonb_build_object('seat', hs.seat, 'cards', to_jsonb(hs.cards),
                                                       'open', case when card_game.room_mode(r.id) = 'A' then hs.open_idx end) order by hs.seat), '[]'::jsonb)
      into v_cards from card_hand_seats hs where hs.hand_id = h.id and hs.in_hand;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'seat', mp.seat, 'player_id', mp.player_id, 'nickname', p.nickname, 'chips', mp.chips,
           'left', mp.left_match, 'is_host', (m.host_player_id = mp.player_id),
           'profit', mp.profit, 'is_winner', mp.is_winner,
           'in_hand', coalesce(hs.in_hand, false), 'folded', coalesce(hs.folded, false),
           'committed', coalesce(hs.committed, 0)) order by mp.seat), '[]'::jsonb)
    into v_seats
    from card_match_players mp
    join card_players p on p.id = mp.player_id
    left join card_hand_seats hs on hs.hand_id = v_hand_id and hs.seat = mp.seat
   where mp.match_id = m.id;

  return jsonb_build_object(
    'server_now', now(),
    'my_seat', null,
    'match', jsonb_build_object(
      'id', m.id, 'room_id', m.room_id, 'room_status', r.status, 'mode', card_game.room_mode(r.id), 'status', m.status,
      'hand_no', m.hand_no, 'max_hands', m.max_hands, 'start_chips', m.start_chips, 'carry', m.carry,
      'host_player_id', m.host_player_id, 'end_reason', m.end_reason, 'next_hand_at', m.next_hand_at,
      'seotda', exists (select 1 from card_room_seotda z where z.room_id = m.room_id)),
    'seats', v_seats,
    'hand', v_hand,
    'actions', v_actions,
    'seat_cards', v_cards,
    'pile', card_game.deck_info(m.id));
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
    'room', jsonb_build_object('id', r.id, 'title', r.title, 'mode', card_game.room_mode(r.id), 'status', r.status,
                               'created_at', r.created_at, 'closed_at', r.closed_at,
                               'hard', coalesce((select o.hard from card_room_options o where o.room_id = r.id), false),
                               'public', exists (select 1 from card_public_rooms pr where pr.room_id = r.id),
                               'seotda', exists (select 1 from card_room_seotda z where z.room_id = r.id)),
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
           and (r.created_at > now() - interval '6 hours'
                or exists (select 1 from card_players p where p.room_id = r.id and p.last_seen > now() - interval '6 hours'))
         order by r.created_at desc
         limit 30
      ) t
  ), '[]'::jsonb);
end $$;

create or replace function public.card_set_room_blind(p_room_id uuid, p_admin_token text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.card_verify_admin(p_room_id, p_admin_token) then raise exception 'FORBIDDEN'; end if;
  if exists (select 1 from card_matches where room_id = p_room_id) then raise exception 'ROOM_IN_USE'; end if;
  if coalesce(p_on, false) then
    insert into card_room_blind (room_id) values (p_room_id) on conflict do nothing;
  else
    delete from card_room_blind where room_id = p_room_id;
  end if;
  perform card_game.notify('card_room:' || p_room_id);
  return jsonb_build_object('blind', coalesce(p_on, false));
end $$;

revoke all on function public.card_set_room_blind(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.card_set_room_blind(uuid, text, boolean) to authenticated;
