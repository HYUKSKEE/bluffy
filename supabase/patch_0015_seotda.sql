-- ⚠️ 수동 패치 (마이그레이션 아님): 섯다 룰(화투 20장). patch_0005, 0006, 0013 을 먼저 실행한 DB 에서 한 번 실행하세요.
-- 새로 0001~0004 를 실행하는 경우에는 필요 없습니다 (이미 반영되어 있음).
--
-- 변경: 새 테이블 card_room_seotda, 새 함수 card_game.seotda_rank / card_game.seotda_special / card_set_room_seotda,
--       교체 함수 5개(card_game.settle_showdown, card_game.start_hand, card_get_room_view, card_list_open_rooms,
--       card_get_match_state, card_spectate_match). card_ 객체만 만들거나 교체한다.

create table if not exists public.card_room_seotda (
  room_id uuid primary key references public.card_rooms(id) on delete cascade
);

alter table public.card_room_seotda enable row level security;
revoke all on public.card_room_seotda from public;
revoke all on public.card_room_seotda from anon, authenticated;

create or replace function card_game.seotda_rank(c int[]) returns int
language sql immutable as $$
  select case
    when m1 = m2 then 9000 + m1 * 10
    when lo = 5 and hi = 15 then 13000
    when (lo = 1 and hi = 15) or (lo = 1 and hi = 5) then 12000
    when least(m1, m2) = 1 and greatest(m1, m2) = 2 then 8000
    when least(m1, m2) = 1 and greatest(m1, m2) = 4 then 7900
    when least(m1, m2) = 1 and greatest(m1, m2) = 9 then 7800
    when least(m1, m2) = 1 and greatest(m1, m2) = 10 then 7700
    when least(m1, m2) = 4 and greatest(m1, m2) = 10 then 7600
    when least(m1, m2) = 4 and greatest(m1, m2) = 6 then 7500
    else 5000 + ((m1 + m2) % 10)
  end
  from (select (c[1] + 1) / 2 as m1, (c[2] + 1) / 2 as m2, least(c[1], c[2]) as lo, greatest(c[1], c[2]) as hi) t
$$;

create or replace function card_game.seotda_special(c int[]) returns text
language sql immutable as $$
  select case
    when least(c[1], c[2]) = 7 and greatest(c[1], c[2]) = 13 then 'amhaeng'
    when least(c[1], c[2]) = 5 and greatest(c[1], c[2]) = 13 then 'ttaengjabi'
  end
$$;

revoke all on function card_game.seotda_rank(int[]), card_game.seotda_special(int[]) from public;

create or replace function card_game.settle_showdown(p_hand uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  h card_hands%rowtype;
  v_level int;
  v_prev int := 0;
  v_roll int := 0;
  v_amount int;
  v_contrib int;
  v_first boolean := true;
  v_win_seats int[];
  v_n int;
  v_each int;
  v_carry int := 0;
  v_won int[] := array[0, 0, 0, 0, 0];
  v_seat int;
  v_json jsonb := '[]'::jsonb;
  v_seotda boolean;
begin
  select * into h from card_hands where id = p_hand;
  v_seotda := exists (select 1 from card_matches m join card_room_seotda z on z.room_id = m.room_id where m.id = h.match_id);

  for v_level in
    select distinct committed from card_hand_seats where hand_id = p_hand and committed > 0 order by committed
  loop
    select count(*) into v_contrib from card_hand_seats where hand_id = p_hand and committed >= v_level;
    v_amount := (v_level - v_prev) * v_contrib + v_roll;
    v_roll := 0;
    if v_first then v_amount := v_amount + h.carry_in; v_first := false; end if;
    v_prev := v_level;

    if v_seotda then
      -- 섯다: 암행어사는 이 팟에 18/13광땡이 있으면 12500, 땡잡이는 1~9땡이 있으면 9095 로 올라간다
      with b as (
        select seat, cards, card_game.seotda_rank(cards) as r
          from card_hand_seats
         where hand_id = p_hand and in_hand and not folded and committed >= v_level),
      e as (
        select seat,
               case when card_game.seotda_special(cards) = 'amhaeng' and exists (select 1 from b where b.r = 12000) then 12500
                    when card_game.seotda_special(cards) = 'ttaengjabi' and exists (select 1 from b where b.r between 9010 and 9090) then 9095
                    else r end as r
          from b)
      select array_agg(seat order by seat) into v_win_seats from e where r = (select max(r) from e);
    else
      with e as (
        select seat, card_game.card_rank(cards) as r
          from card_hand_seats
         where hand_id = p_hand and in_hand and not folded and committed >= v_level)
      select array_agg(seat order by seat) into v_win_seats from e where r = (select max(r) from e);
    end if;

    if v_win_seats is null then
      v_roll := v_amount;            -- 이 단계에 자격 있는 생존자가 없으면 다음 단계로 합친다 (방어 코드)
    else
      v_n := cardinality(v_win_seats);
      v_each := v_amount / v_n;
      v_carry := v_carry + v_amount % v_n;
      foreach v_seat in array v_win_seats loop
        v_won[v_seat] := v_won[v_seat] + v_each;
      end loop;
    end if;
  end loop;
  v_carry := v_carry + v_roll;

  for v_seat in 1..5 loop
    if v_won[v_seat] > 0 then
      update card_match_players set chips = chips + v_won[v_seat] where match_id = h.match_id and seat = v_seat;
      v_json := v_json || jsonb_build_array(jsonb_build_object('seat', v_seat, 'amount', v_won[v_seat]));
    end if;
  end loop;
  perform card_game.close_hand(p_hand, 'showdown', true, v_json, v_carry);
end $$;

create or replace function card_game.start_hand(p_match uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  m card_matches%rowtype;
  v_alive int[];
  v_n int;
  v_no int;
  v_lead int;
  v_deck int[];
  v_hand uuid;
  v_i int;
  v_actors int;
  v_antes int;
  v_level int;
  v_hard boolean;
  v_seotda boolean;
  d card_match_decks%rowtype;
  v_all int[];
  v_deal int[] := '{}';
  v_c int;
  v_real int;
  v_reshuffle boolean := false;
  v_marker boolean := false;
begin
  select * into m from card_matches where id = p_match for update;
  v_no := m.hand_no + 1;
  select array_agg(seat order by seat) into v_alive
    from card_match_players where match_id = p_match and not left_match and chips > 0;
  v_n := coalesce(cardinality(v_alive), 0);
  if v_n < 2 then
    perform card_game.finish_match(p_match);
    return null;
  end if;
  v_lead := v_alive[((v_no - 1) % v_n) + 1];   -- 선은 판마다 한 칸씩 이동 (칩이 남은 사람 기준)

  select coalesce(o.hard, false) into v_hard from card_rooms r left join card_room_options o on o.room_id = r.id where r.id = m.room_id;
  v_seotda := exists (select 1 from card_room_seotda z where z.room_id = m.room_id);

  if v_hard then
    -- 고난이도: 매치 내내 공용 덱을 이어서 쓴다. 셔플은 (1) 첫 판 (2) 남은 카드가 모자랄 때 (3) 셔플 예고 카드가 나온 판 다음에만.
    select * into d from card_match_decks where match_id = p_match for update;
    if not found then
      -- 필요 세트 수 = 인원 × 2장 × 3라운드 ÷ 10 (올림). 섯다는 한 벌이 20장이라 세트 수를 2의 배수로 맞춘다.
      insert into card_match_decks (match_id, sets, deck, shuffle_no, fresh, marker_out)
      values (p_match, case when v_seotda then 2 * ceil(v_n * 2 * 3 / 20.0)::int else ceil(v_n * 2 * 3 / 10.0)::int end, '{}', 0, true, false) returning * into d;
      v_reshuffle := true;
    else
      select count(*) into v_real from unnest(d.deck) x where x <> 0;
      v_reshuffle := d.marker_out or v_real < 2 * v_n;
    end if;
    if v_reshuffle then
      -- 남은 카드와 버린 카드를 모두 합쳐(공개 없이) 다시 섞고, 아래에서 1라운드 분량 위치에 셔플 예고 카드(0)를 끼운다.
      select array_agg(n order by gen_random_uuid()) into v_all
        from (select (i % (case when v_seotda then 20 else 10 end)) + 1 as n from generate_series(0, d.sets * 10 - 1) i) s;
      v_all := v_all[1 : cardinality(v_all) - 2 * v_n] || array[0] || v_all[cardinality(v_all) - 2 * v_n + 1 :];
      d.deck := v_all;
      d.shuffle_no := d.shuffle_no + 1;
      d.fresh := true;
    else
      d.fresh := false;
    end if;
    d.marker_out := false;
    -- 위에서부터 2장씩 나눠 준다. 예고 카드가 나오면 옆으로 빼두고(이번 판이 끝나면 셔플) 다음 카드를 이어서 뽑는다.
    while cardinality(v_deal) < 2 * v_n loop
      v_c := d.deck[1];
      d.deck := d.deck[2:];
      if v_c = 0 then d.marker_out := true; else v_deal := v_deal || v_c; end if;
    end loop;
    update card_match_decks set deck = d.deck, shuffle_no = d.shuffle_no, fresh = d.fresh, marker_out = d.marker_out
     where match_id = p_match;
    v_deck := v_deal;
  else
    -- 일반: 판마다 1~10 두 벌을 CSPRNG(gen_random_uuid)로 새로 섞는다
    select array_agg(n order by gen_random_uuid()) into v_deck
      from (select (i % (case when v_seotda then 20 else 10 end)) + 1 as n from generate_series(0, 19) i) s;
  end if;

  -- 기본 판돈(앤티) = 매 판 1칩 고정. 칩이 없으면 참가하지 않는다.
  select coalesce(sum(least(chips, 1)), 0), coalesce(max(least(chips, 1)), 0) into v_antes, v_level
    from card_match_players where match_id = p_match and seat = any (v_alive);

  insert into card_hands (match_id, hand_no, deck, pot, carry_in, level, lead_seat)
  values (p_match, v_no, v_deck, m.carry + v_antes, m.carry, v_level, v_lead)
  returning id into v_hand;

  for v_i in 1..v_n loop
    insert into card_hand_seats (hand_id, seat, cards, open_idx, in_hand, committed)
    values (v_hand, v_alive[v_i], array[v_deck[2 * v_i - 1], v_deck[2 * v_i]],
            1 + (get_byte(uuid_send(gen_random_uuid()), 15) & 1), true,
            (select least(chips, 1) from card_match_players where match_id = p_match and seat = v_alive[v_i]));
  end loop;

  update card_match_players set chips = chips - least(chips, 1) where match_id = p_match and seat = any (v_alive);
  update card_matches set hand_no = v_no, carry = 0, next_hand_at = null where id = p_match;

  -- 앤티를 내고도 칩이 남은 사람만 행동할 수 있다. 행동할 사람이 1명 이하면 베팅 없이 쇼다운.
  update card_hand_seats hs set pending = (mp.chips > 0)
    from card_match_players mp
   where hs.hand_id = v_hand and mp.match_id = p_match and mp.seat = hs.seat;
  select count(*) into v_actors from card_hand_seats where hand_id = v_hand and pending;
  if v_actors <= 1 then
    update card_hand_seats set pending = false where hand_id = v_hand;
  end if;

  perform card_game.advance(v_hand, v_lead, true);
  perform card_game.notify('card_match:' || p_match);
  return v_hand;
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
        select r.id, r.title, r.mode, r.created_at,
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
      'id', m.id, 'room_id', m.room_id, 'room_status', r.status, 'mode', r.mode, 'status', m.status,
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
                                                       'open', case when r.mode = 'A' then hs.open_idx end) order by hs.seat), '[]'::jsonb)
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
      'id', m.id, 'room_id', m.room_id, 'room_status', r.status, 'mode', r.mode, 'status', m.status,
      'hand_no', m.hand_no, 'max_hands', m.max_hands, 'start_chips', m.start_chips, 'carry', m.carry,
      'host_player_id', m.host_player_id, 'end_reason', m.end_reason, 'next_hand_at', m.next_hand_at,
      'seotda', exists (select 1 from card_room_seotda z where z.room_id = m.room_id)),
    'seats', v_seats,
    'hand', v_hand,
    'actions', v_actions,
    'seat_cards', v_cards,
    'pile', card_game.deck_info(m.id));
end $$;

create or replace function public.card_set_room_seotda(p_room_id uuid, p_admin_token text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.card_verify_admin(p_room_id, p_admin_token) then raise exception 'FORBIDDEN'; end if;
  if exists (select 1 from card_matches where room_id = p_room_id) then raise exception 'ROOM_IN_USE'; end if;
  if coalesce(p_on, false) then
    insert into card_room_seotda (room_id) values (p_room_id) on conflict do nothing;
  else
    delete from card_room_seotda where room_id = p_room_id;
  end if;
  perform card_game.notify('card_room:' || p_room_id);
  return jsonb_build_object('seotda', coalesce(p_on, false));
end $$;

revoke all on function public.card_set_room_seotda(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.card_set_room_seotda(uuid, text, boolean) to authenticated;
