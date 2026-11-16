-- ⚠️ 수동 패치 (마이그레이션 아님): 판돈이 커지는 규칙 제거. patch_0005, 0006, 0008 까지 실행한 DB 에서 한 번 실행하세요.
-- (앤티 = 판 번호 / 베팅 1칸 = 앤티 규칙을 되돌려, 앤티 1칩 고정 + 베팅 1~3칩으로 만든다. 이전에 patch_0007 을 실행했어도 이 패치가 덮어쓴다.)
-- 새로 0001~0004 를 실행하는 경우에는 필요 없습니다 (이미 반영되어 있음).
--
-- 이 게임의 card_game.start_hand, card_game.apply_action 두 함수만 교체한다(실행 권한 유지). 다른 게임의 객체는 건드리지 않는다.

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

  if v_hard then
    -- 고난이도: 매치 내내 공용 덱을 이어서 쓴다. 셔플은 (1) 첫 판 (2) 남은 카드가 모자랄 때 (3) 셔플 예고 카드가 나온 판 다음에만.
    select * into d from card_match_decks where match_id = p_match for update;
    if not found then
      -- 필요 세트 수 = 인원 × 2장 × 3라운드 ÷ 10 (올림)
      insert into card_match_decks (match_id, sets, deck, shuffle_no, fresh, marker_out)
      values (p_match, ceil(v_n * 2 * 3 / 10.0)::int, '{}', 0, true, false) returning * into d;
      v_reshuffle := true;
    else
      select count(*) into v_real from unnest(d.deck) x where x <> 0;
      v_reshuffle := d.marker_out or v_real < 2 * v_n;
    end if;
    if v_reshuffle then
      -- 남은 카드와 버린 카드를 모두 합쳐(공개 없이) 다시 섞고, 아래에서 1라운드 분량 위치에 셔플 예고 카드(0)를 끼운다.
      select array_agg(n order by gen_random_uuid()) into v_all
        from (select (i % 10) + 1 as n from generate_series(0, d.sets * 10 - 1) i) s;
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
      from (select (i % 10) + 1 as n from generate_series(0, 19) i) s;
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

create or replace function card_game.apply_action(
  p_hand uuid, p_player uuid, p_action text, p_amount int, p_auto boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare
  h card_hands%rowtype;
  m card_matches%rowtype;
  v_seat int;
  my_stack int;
  my_c int;
  to_call int;
  mx int;
  pay int;
  v_level int;
  v_pot int;
  v_raise int;
  v_logamt int := 0;
  v_folded boolean := false;
  v_raised boolean := false;
begin
  select * into h from card_hands where id = p_hand;
  select * into m from card_matches where id = h.match_id;
  if m.status <> 'playing' or h.status <> 'betting' then raise exception 'HAND_NOT_ACTIVE'; end if;

  select seat, chips into v_seat, my_stack from card_match_players where match_id = m.id and player_id = p_player;
  if v_seat is null or h.turn_seat is distinct from v_seat then raise exception 'NOT_YOUR_TURN'; end if;

  select committed into my_c from card_hand_seats where hand_id = p_hand and seat = v_seat;
  to_call := h.level - my_c;
  v_level := h.level;
  v_pot := h.pot;
  v_raise := h.raise_count;

  if p_action = 'check' then
    if to_call <> 0 then raise exception 'CANNOT_CHECK'; end if;

  elsif p_action in ('bet', 'raise') then
    if (p_action = 'bet') <> (to_call = 0) then raise exception 'WRONG_ACTION'; end if;
    if v_raise >= 3 then raise exception 'RAISE_LIMIT'; end if;
    mx := least(3, my_stack - to_call);       -- 최대 3칩, 가진 칩(콜 금액 제외)을 넘을 수 없다
    if p_amount is null or p_amount < 1 or p_amount > mx then raise exception 'BAD_AMOUNT'; end if;
    pay := to_call + p_amount;
    my_stack := my_stack - pay;
    my_c := my_c + pay;
    v_pot := v_pot + pay;
    v_level := v_level + p_amount;
    v_raise := v_raise + 1;
    v_raised := true;
    v_logamt := p_amount;

  elsif p_action = 'call' then
    if to_call <= 0 then raise exception 'NOTHING_TO_CALL'; end if;
    pay := least(to_call, my_stack);          -- 칩이 모자라면 남은 칩 전부로 콜(올인). 초과분은 사이드 팟에서 정리된다
    my_stack := my_stack - pay;
    my_c := my_c + pay;
    v_pot := v_pot + pay;
    v_logamt := pay;

  elsif p_action = 'die' then
    v_folded := true;

  else
    raise exception 'UNKNOWN_ACTION';
  end if;

  update card_match_players set chips = my_stack where match_id = m.id and seat = v_seat;
  update card_hand_seats set committed = my_c, pending = false, folded = (folded or v_folded)
   where hand_id = p_hand and seat = v_seat;
  update card_hands
     set pot = v_pot, level = v_level, raise_count = v_raise,
         current_bet = case when v_raised then p_amount else current_bet end
   where id = p_hand;

  if v_raised then
    -- 레이즈가 나오면 칩이 남은 다른 생존자 전원이 다시 행동해야 한다
    update card_hand_seats hs set pending = true
      from card_match_players mp
     where hs.hand_id = p_hand and mp.match_id = m.id and mp.seat = hs.seat
       and hs.seat <> v_seat and hs.in_hand and not hs.folded and mp.chips > 0;
  end if;

  insert into card_actions (hand_id, player_id, seat, action, amount, auto)
  values (p_hand, p_player, v_seat, p_action, v_logamt, p_auto);

  perform card_game.advance(p_hand, v_seat, false);
  perform card_game.notify('card_match:' || m.id);
end $$;
