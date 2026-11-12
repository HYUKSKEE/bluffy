-- 0002_game_engine.sql : 덱 섞기, 배분, 베팅 검증, 승패 판정, 칩/사이드 팟 계산 (2~5인)
-- 전부 card_game 스키마의 내부 함수다. 클라이언트는 호출할 수 없고, 0003 의 RPC 만 이 함수를 부른다.
-- 호출하는 쪽(RPC)이 card_matches 행 → card_hands 행 순서로 FOR UPDATE 잠금을 먼저 잡아야 한다.
--
-- 규칙: 시작 칩 100 / 최대 10판 / 기본 판돈 1 / 레이즈 판당 최대 3회, 1~3칩 / 턴 20초 / 2~5명
--
-- 베팅 모델(한 판 = 한 라운드):
--   level   = 이번 판에서 가장 많이 건 사람의 누적 금액
--   to_call = level - 내가 건 금액
--   pending = 아직 행동해야 하는 좌석. 레이즈가 나오면 (칩이 남은) 다른 생존자 전원이 다시 pending 이 된다.
--   pending 이 모두 비면 쇼다운, 생존자가 1명이면 그 사람이 판돈을 가져간다.
--   올인/무승부는 사이드 팟(건 금액 단계별 판돈)으로 나눈다.

-- Realtime 신호: 카드·칩 값은 싣지 않고 "바뀌었다"는 신호만 보낸다. 실패해도 게임은 계속된다.
create function card_game.notify(p_topic text, p_event text default 'changed')
returns void language plpgsql security definer set search_path = public as $$
begin
  perform realtime.send(jsonb_build_object('ts', extract(epoch from clock_timestamp())), p_event, p_topic, false);
exception when others then
  null;
end $$;

-- 족보 키: [2, 숫자] = 페어, [1, 합] = 합. 배열 비교(>)가 곧 족보 비교다.
create function card_game.card_rank(c int[]) returns int[]
language sql immutable as $$
  select case when c[1] = c[2] then array[2, c[1]] else array[1, c[1] + c[2]] end
$$;

-- ───────────── 매치 종료 ─────────────
-- 승자 = 나가지 않은 사람 중 칩이 가장 많은 사람(동점이면 공동 승자). 수익 = 최종 칩 - 시작 칩.
-- 기권자는 이득을 챙길 수 없다: 수익 = min(최종 칩 - 시작 칩, 0).
create function card_game.finish_match(p_match uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m card_matches%rowtype;
  v_max int;
  v_remaining int;
  v_left int;
  v_reason text;
begin
  select * into m from card_matches where id = p_match for update;
  if not found or m.status <> 'playing' then return; end if;

  select count(*) filter (where not left_match and chips > 0), count(*) filter (where left_match)
    into v_remaining, v_left from card_match_players where match_id = p_match;
  v_reason := case when v_remaining <= 1 then (case when v_left > 0 then 'forfeit' else 'bust' end) else 'complete' end;

  select max(chips) into v_max from card_match_players where match_id = p_match and not left_match;
  update card_match_players
     set is_winner = (not left_match and v_max is not null and chips = v_max),
         profit = case when left_match then least(chips - m.start_chips, 0) else chips - m.start_chips end
   where match_id = p_match;

  update card_matches set status = 'finished', end_reason = v_reason, finished_at = now(), next_hand_at = null
   where id = p_match;

  update card_players p
     set total_profit = p.total_profit + s.profit,
         matches_played = p.matches_played + 1,
         matches_won = p.matches_won + (case when s.is_winner then 1 else 0 end),
         status = case when s.left_match then p.status else 'idle' end,        -- 먼저 나간 사람의 상태는 건드리지 않음
         queued_at = case when s.left_match then p.queued_at else null end
    from card_match_players s
   where s.match_id = p_match and s.player_id = p.id;

  perform card_game.notify('card_match:' || p_match);
  perform card_game.notify('card_room:' || m.room_id);
end $$;

-- ───────────── 판 종료 공통 ─────────────
create function card_game.close_hand(p_hand uuid, p_reason text, p_revealed boolean, p_winners jsonb, p_carry int)
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

-- 다른 모두가 다이/이탈: 남은 한 명이 판돈 전부를 가져간다 (판이 끝나면 패는 모두 공개된다)
create function card_game.settle_fold(p_hand uuid, p_winner_seat int)
returns void language plpgsql security definer set search_path = public as $$
declare
  h card_hands%rowtype;
begin
  select * into h from card_hands where id = p_hand;
  update card_match_players set chips = chips + h.pot where match_id = h.match_id and seat = p_winner_seat;
  perform card_game.close_hand(p_hand, 'fold', true,
    jsonb_build_array(jsonb_build_object('seat', p_winner_seat, 'amount', h.pot)), 0);
end $$;

-- 쇼다운: 건 금액 단계별(사이드 팟)로 생존자 중 가장 높은 족보가 가져간다. 동점이면 나누고 남는 칩은 이월.
create function card_game.settle_showdown(p_hand uuid)
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
begin
  select * into h from card_hands where id = p_hand;

  for v_level in
    select distinct committed from card_hand_seats where hand_id = p_hand and committed > 0 order by committed
  loop
    select count(*) into v_contrib from card_hand_seats where hand_id = p_hand and committed >= v_level;
    v_amount := (v_level - v_prev) * v_contrib + v_roll;
    v_roll := 0;
    if v_first then v_amount := v_amount + h.carry_in; v_first := false; end if;
    v_prev := v_level;

    with e as (
      select seat, card_game.card_rank(cards) as r
        from card_hand_seats
       where hand_id = p_hand and in_hand and not folded and committed >= v_level)
    select array_agg(seat order by seat) into v_win_seats from e where r = (select max(r) from e);

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

-- ───────────── 다음 차례 / 판 종료 판정 ─────────────
-- p_from 좌석 "다음"(p_inclusive 면 "포함")부터 시계방향으로 pending 인 좌석에게 차례를 넘긴다.
create function card_game.advance(p_hand uuid, p_from int, p_inclusive boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_alive int;
  v_winner int;
  v_next int;
begin
  select count(*), min(seat) into v_alive, v_winner
    from card_hand_seats where hand_id = p_hand and in_hand and not folded;
  if v_alive = 1 then
    perform card_game.settle_fold(p_hand, v_winner);
    return;
  end if;
  if not exists (select 1 from card_hand_seats where hand_id = p_hand and pending) then
    perform card_game.settle_showdown(p_hand);
    return;
  end if;
  select seat into v_next from card_hand_seats
   where hand_id = p_hand and pending
   order by (case when (case when p_inclusive then seat >= p_from else seat > p_from end) then 0 else 1 end), seat
   limit 1;
  update card_hands set turn_seat = v_next, turn_deadline = now() + interval '20 seconds' where id = p_hand;
end $$;

-- ───────────── 판 시작: 덱 섞기 + 배분 + 기본 판돈 ─────────────
create function card_game.start_hand(p_match uuid)
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

  insert into card_hands (match_id, hand_no, deck, pot, carry_in, level, lead_seat)
  values (p_match, v_no, v_deck, m.carry + v_n, m.carry, 1, v_lead)
  returning id into v_hand;

  for v_i in 1..v_n loop
    insert into card_hand_seats (hand_id, seat, cards, open_idx, in_hand, committed)
    values (v_hand, v_alive[v_i], array[v_deck[2 * v_i - 1], v_deck[2 * v_i]],
            1 + (get_byte(uuid_send(gen_random_uuid()), 15) & 1), true, 1);
  end loop;

  update card_match_players set chips = chips - 1 where match_id = p_match and seat = any (v_alive);
  update card_matches set hand_no = v_no, carry = 0, next_hand_at = null where id = p_match;

  -- 기본 판돈을 내고도 칩이 남은 사람만 행동할 수 있다. 행동할 사람이 1명 이하면 베팅 없이 쇼다운.
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

-- ───────────── 행동 적용(검증 포함) ─────────────
-- p_player 는 card_players.id. 규칙 위반은 예외로 거부한다.
create function card_game.apply_action(
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

-- ───────────── 기권(나가기/응답 없음) ─────────────
-- 나간 사람은 현재 판에서 다이 처리되고(건 칩은 판돈에 남음) 이후 판에서 제외된다.
-- 남은 사람이 1명 이하가 되면 매치가 끝난다.
create function card_game.forfeit(p_match uuid, p_player uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m card_matches%rowtype;
  h card_hands%rowtype;
  v_seat int;
  v_remaining int;
begin
  select * into m from card_matches where id = p_match for update;
  if not found or m.status <> 'playing' then return; end if;
  select seat into v_seat from card_match_players where match_id = p_match and player_id = p_player and not left_match;
  if v_seat is null then return; end if;

  update card_match_players set left_match = true where match_id = p_match and seat = v_seat;
  update card_players set status = 'idle', queued_at = null where id = p_player;

  select * into h from card_hands where match_id = p_match order by hand_no desc limit 1 for update;
  if found and h.status = 'betting'
     and exists (select 1 from card_hand_seats where hand_id = h.id and seat = v_seat and in_hand and not folded) then
    update card_hand_seats set folded = true, pending = false where hand_id = h.id and seat = v_seat;
    insert into card_actions (hand_id, player_id, seat, action, amount, auto) values (h.id, p_player, v_seat, 'die', 0, true);
    perform card_game.advance(h.id, v_seat, false);     -- 판이 끝나면 close_hand 가 매치 종료까지 판단한다
  else
    select count(*) into v_remaining from card_match_players where match_id = p_match and not left_match and chips > 0;
    if v_remaining <= 1 then perform card_game.finish_match(p_match); end if;
  end if;
  perform card_game.notify('card_match:' || p_match);
  perform card_game.notify('card_room:' || m.room_id);
end $$;

-- ───────────── 대기 테이블 ─────────────
create function card_game.remove_waiting_seat(p_match uuid, p_player uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m card_matches%rowtype;
  v_new_host uuid;
begin
  select * into m from card_matches where id = p_match for update;
  if not found or m.status <> 'waiting' then return; end if;
  delete from card_match_players where match_id = p_match and player_id = p_player;
  update card_players set status = 'idle', queued_at = null where id = p_player;
  select player_id into v_new_host from card_match_players where match_id = p_match order by seat limit 1;
  if v_new_host is null then
    update card_matches set status = 'void', end_reason = 'void' where id = p_match;     -- 아무도 없으면 테이블 닫힘
  elsif m.host_player_id = p_player then
    update card_matches set host_player_id = v_new_host where id = p_match;              -- 방장이 나가면 다음 사람이 방장
  end if;
  perform card_game.notify('card_match:' || p_match);
  perform card_game.notify('card_room:' || m.room_id);
end $$;

-- 30초 넘게 신호가 없는 대기자(탭을 닫은 사람)를 대기 테이블에서 내보낸다
create function card_game.prune_waiting(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r record;
begin
  for r in
    select mp.match_id, mp.player_id
      from card_match_players mp
      join card_matches mt on mt.id = mp.match_id
      join card_players p on p.id = mp.player_id
     where mt.room_id = p_room and mt.status = 'waiting' and p.last_seen < now() - interval '30 seconds'
  loop
    perform card_game.remove_waiting_seat(r.match_id, r.player_id);
  end loop;
end $$;

-- 대기 테이블 → 진행. 모두 시작 칩을 받고 1판이 시작된다.
create function card_game.begin_match(p_match uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m card_matches%rowtype;
begin
  select * into m from card_matches where id = p_match for update;
  update card_matches set status = 'playing', started_at = now() where id = p_match;
  update card_match_players set chips = m.start_chips where match_id = p_match;
  update card_players set status = 'playing', queued_at = null
   where id in (select player_id from card_match_players where match_id = p_match);
  perform card_game.start_hand(p_match);
  perform card_game.notify('card_room:' || m.room_id);
end $$;

revoke all on all functions in schema card_game from public;
