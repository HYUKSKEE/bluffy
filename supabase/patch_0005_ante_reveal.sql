-- ⚠️ 수동 패치 (마이그레이션 아님). 0001~0004 를 "이미" 실행한 DB 에만 한 번 실행하세요.
-- 새로 0001~0004 를 실행하는 경우에는 필요 없습니다 (이미 반영되어 있음).
--
-- 변경 내용
--  1) 한 판이 끝나면(쇼다운이든 모두 다이든) 그 판에 참여한 모든 좌석의 패를 공개한다.
--  2) 기본 판돈(앤티) = 판 번호 (1판 1칩 ... 10판 10칩). 칩이 모자라면 가진 칩 전부.
--  3) 관전 화면에서 A 모드의 "공개 카드 위치"(open)를 구분할 수 있게 한다.
-- 이 게임의 card_game.close_hand / settle_fold / start_hand, public.card_get_visible_hand / card_spectate_match
-- 다섯 함수만 교체한다(기존 실행 권한은 유지됨). 다른 게임의 객체는 건드리지 않는다.

create or replace function card_game.close_hand(p_hand uuid, p_reason text, p_revealed boolean, p_winners jsonb, p_carry int)
returns void language plpgsql security definer set search_path = public as $$
declare
  h card_hands%rowtype;
  m card_matches%rowtype;
  v_remaining int;
begin
  select * into h from card_hands where id = p_hand;
  select * into m from card_matches where id = h.match_id;

  update card_hands
     set status = 'finished', revealed = p_revealed, current_bet = 0, turn_seat = null, turn_deadline = null,
         result = jsonb_build_object('reason', p_reason, 'pot', h.pot, 'carry', p_carry, 'winners', p_winners)
   where id = p_hand;
  update card_hand_seats set pending = false where hand_id = p_hand;
  update card_matches set carry = p_carry where id = m.id;

  select count(*) into v_remaining from card_match_players where match_id = m.id and not left_match and chips > 0;
  if v_remaining <= 1 or m.hand_no >= m.max_hands then
    perform card_game.finish_match(m.id);
  else
    -- 결과 연출을 볼 시간(쇼다운 6초, 다이로 끝나면 4초) 뒤에 다음 판 시작 가능
    update card_matches
       set next_hand_at = now() + (case when p_reason = 'showdown' then interval '6 seconds' else interval '4 seconds' end)
     where id = m.id;
  end if;
  perform card_game.notify('card_match:' || m.id);
end $$;

create or replace function card_game.settle_fold(p_hand uuid, p_winner_seat int)
returns void language plpgsql security definer set search_path = public as $$
declare
  h card_hands%rowtype;
begin
  select * into h from card_hands where id = p_hand;
  update card_match_players set chips = chips + h.pot where match_id = h.match_id and seat = p_winner_seat;
  perform card_game.close_hand(p_hand, 'fold', true,
    jsonb_build_array(jsonb_build_object('seat', p_winner_seat, 'amount', h.pot)), 0);
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

  -- 1~10 두 벌을 CSPRNG(gen_random_uuid)로 섞는다
  select array_agg(n order by gen_random_uuid()) into v_deck
    from (select (i % 10) + 1 as n from generate_series(0, 19) i) s;

  -- 기본 판돈(앤티) = 판 번호 (1판 1칩, 2판 2칩, ... 10판 10칩). 칩이 모자라면 가진 칩 전부.
  -- 계속 다이만 해도 앤티가 쌓여서, 초반에 크게 이긴 사람이 숨어서 이기는 것을 막는다.
  select coalesce(sum(least(chips, v_no)), 0), coalesce(max(least(chips, v_no)), 0) into v_antes, v_level
    from card_match_players where match_id = p_match and seat = any (v_alive);

  insert into card_hands (match_id, hand_no, deck, pot, carry_in, level, lead_seat)
  values (p_match, v_no, v_deck, m.carry + v_antes, m.carry, v_level, v_lead)
  returning id into v_hand;

  for v_i in 1..v_n loop
    insert into card_hand_seats (hand_id, seat, cards, open_idx, in_hand, committed)
    values (v_hand, v_alive[v_i], array[v_deck[2 * v_i - 1], v_deck[2 * v_i]],
            1 + (get_byte(uuid_send(gen_random_uuid()), 15) & 1), true,
            (select least(chips, v_no) from card_match_players where match_id = p_match and seat = v_alive[v_i]));
  end loop;

  update card_match_players set chips = chips - least(chips, v_no) where match_id = p_match and seat = any (v_alive);
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
  v_seats jsonb := '[]'::jsonb;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into m from card_matches where id = p_match_id;
  if not found then raise exception 'MATCH_NOT_FOUND'; end if;
  select mp.seat into v_my_seat from card_match_players mp join card_players p on p.id = mp.player_id
   where mp.match_id = p_match_id and p.uid = v_uid;
  if v_my_seat is null then raise exception 'NOT_A_PLAYER'; end if;

  select * into r from card_rooms where id = m.room_id;
  select * into h from card_hands
   where match_id = p_match_id and (p_hand_no is null or hand_no = p_hand_no)
   order by hand_no desc limit 1;
  if not found then return null; end if;

  for hs in select * from card_hand_seats where hand_id = h.id order by seat loop
    if h.revealed and hs.in_hand then
      v_cards := hs.cards;                                              -- 판이 끝나면 그 판에 참여한 모든 좌석의 패를 공개
    elsif hs.seat = v_my_seat then
      v_cards := case when r.mode = 'A' then hs.cards else array[null, null]::int[] end;
    elsif r.mode = 'A' then
      v_cards := array[case when hs.open_idx = 1 then hs.cards[1] end, case when hs.open_idx = 2 then hs.cards[2] end];
    else
      v_cards := hs.cards;
    end if;
    v_seats := v_seats || jsonb_build_array(jsonb_build_object(
      'seat', hs.seat, 'cards', to_jsonb(v_cards), 'open', case when r.mode = 'A' then hs.open_idx end));
  end loop;

  return jsonb_build_object('hand_id', h.id, 'hand_no', h.hand_no, 'mode', r.mode,
                            'my_seat', v_my_seat, 'revealed', h.revealed, 'seats', v_seats);
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
      'host_player_id', m.host_player_id, 'end_reason', m.end_reason, 'next_hand_at', m.next_hand_at),
    'seats', v_seats,
    'hand', v_hand,
    'actions', v_actions,
    'seat_cards', v_cards);
end $$;
