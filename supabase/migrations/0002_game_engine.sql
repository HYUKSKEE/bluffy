-- 0002_game_engine.sql : 덱 섞기, 배분, 베팅 검증, 승패 판정, 칩 계산
-- 전부 game 스키마의 내부 함수다. 클라이언트는 호출할 수 없고, 0003 의 RPC 만 이 함수를 부른다.
-- 호출하는 쪽(RPC)이 matches 행 → hands 행 순서로 FOR UPDATE 잠금을 먼저 잡아야 한다.
--
-- 규칙 상수: 시작 칩 20 / 최대 5판 / 기본 판돈 1 / 레이즈 최대 3회, 1~3칩 / 턴 20초

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
-- p_forfeiter: 기권/시간초과로 나간 플레이어 (있으면 상대가 승리, 나간 쪽은 이득을 챙길 수 없음)
create function card_game.finish_match(p_match uuid, p_forfeiter uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  m card_matches%rowtype;
  v_winner uuid;
  v_reason text;
  p1 int;
  p2 int;
begin
  select * into m from card_matches where id = p_match for update;
  if not found or m.status <> 'playing' then return; end if;

  if p_forfeiter is not null then
    v_winner := case when p_forfeiter = m.player1_id then m.player2_id else m.player1_id end;
    v_reason := 'forfeit';
  else
    v_winner := case when m.chips1 > m.chips2 then m.player1_id
                     when m.chips2 > m.chips1 then m.player2_id end;   -- 같으면 null(무승부)
    v_reason := case when m.chips1 = 0 or m.chips2 = 0 then 'bust' else 'complete' end;
  end if;

  p1 := m.chips1 - 20;
  p2 := m.chips2 - 20;
  if p_forfeiter = m.player1_id then p1 := least(p1, 0); end if;
  if p_forfeiter = m.player2_id then p2 := least(p2, 0); end if;

  update card_matches
     set status = 'finished', winner_id = v_winner, end_reason = v_reason,
         profit1 = p1, profit2 = p2, finished_at = now(), next_hand_at = null
   where id = p_match;

  update card_players
     set total_profit = total_profit + p1, matches_played = matches_played + 1,
         matches_won = matches_won + (case when id = v_winner then 1 else 0 end),
         status = 'idle', queued_at = null
   where id = m.player1_id;
  update card_players
     set total_profit = total_profit + p2, matches_played = matches_played + 1,
         matches_won = matches_won + (case when id = v_winner then 1 else 0 end),
         status = 'idle', queued_at = null
   where id = m.player2_id;

  perform card_game.notify('card_match:' || p_match);
  perform card_game.notify('card_room:' || m.room_id);
end $$;

-- ───────────── 판 정산 ─────────────
-- p_winner null = 무승부(반씩, 홀수 칩은 이월). 정산 후 매치 종료 여부를 판단한다.
create function card_game.settle_hand(p_hand uuid, p_winner uuid, p_reveal boolean, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  h card_hands%rowtype;
  m card_matches%rowtype;
  v_c1 int;
  v_c2 int;
  v_carry int := 0;
begin
  select * into h from card_hands where id = p_hand;
  select * into m from card_matches where id = h.match_id;
  v_c1 := m.chips1;
  v_c2 := m.chips2;

  if p_winner = m.player1_id then
    v_c1 := v_c1 + h.pot;
  elsif p_winner = m.player2_id then
    v_c2 := v_c2 + h.pot;
  else
    v_c1 := v_c1 + h.pot / 2;
    v_c2 := v_c2 + h.pot / 2;
    v_carry := h.pot % 2;
  end if;

  update card_hands
     set status = 'finished', revealed = p_reveal, current_bet = 0,
         turn_player_id = null, turn_deadline = null,
         result = jsonb_build_object('winner_id', p_winner, 'reason', p_reason, 'pot', h.pot, 'carry', v_carry)
   where id = p_hand;
  update card_matches set chips1 = v_c1, chips2 = v_c2, carry = v_carry where id = m.id;

  if v_c1 = 0 or v_c2 = 0 or m.hand_no >= 5 then
    perform card_game.finish_match(m.id);
  else
    -- 결과 연출을 볼 시간(쇼다운 5초, 다이 2초) 뒤에 다음 판 시작 가능
    update card_matches
       set next_hand_at = now() + (case when p_reveal then interval '5 seconds' else interval '2 seconds' end)
     where id = m.id;
  end if;
  perform card_game.notify('card_match:' || m.id);
end $$;

create function card_game.showdown(p_hand uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  h card_hands%rowtype;
  m card_matches%rowtype;
  v_winner uuid;
begin
  select * into h from card_hands where id = p_hand;
  select * into m from card_matches where id = h.match_id;
  v_winner := case when card_game.card_rank(h.cards1) > card_game.card_rank(h.cards2) then m.player1_id
                   when card_game.card_rank(h.cards2) > card_game.card_rank(h.cards1) then m.player2_id end;
  perform card_game.settle_hand(p_hand, v_winner, true, case when v_winner is null then 'tie' else 'showdown' end);
end $$;

create function card_game.fold(p_hand uuid, p_loser uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  h card_hands%rowtype;
  m card_matches%rowtype;
begin
  select * into h from card_hands where id = p_hand;
  select * into m from card_matches where id = h.match_id;
  perform card_game.settle_hand(
    p_hand,
    case when p_loser = m.player1_id then m.player2_id else m.player1_id end,
    false, 'fold');
end $$;

-- ───────────── 판 시작: 덱 섞기 + 배분 + 기본 판돈 ─────────────
create function card_game.start_hand(p_match uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  m card_matches%rowtype;
  v_deck int[];
  v_no int;
  v_lead uuid;
  v_hand uuid;
  v_s1 int;
  v_s2 int;
begin
  select * into m from card_matches where id = p_match for update;
  v_no := m.hand_no + 1;
  v_lead := case when v_no % 2 = 1 then m.player1_id else m.player2_id end;   -- 선 교대
  v_s1 := m.chips1 - 1;
  v_s2 := m.chips2 - 1;

  -- 1~10 두 벌을 CSPRNG(gen_random_uuid)로 섞는다
  select array_agg(n order by gen_random_uuid()) into v_deck
    from (select (i % 10) + 1 as n from generate_series(0, 19) i) s;

  insert into card_hands (match_id, hand_no, deck, cards1, cards2, open1, open2, pot,
                     committed1, committed2, lead_player_id, turn_player_id, turn_deadline)
  values (p_match, v_no, v_deck,
          array[v_deck[1], v_deck[2]], array[v_deck[3], v_deck[4]],
          1 + (get_byte(uuid_send(gen_random_uuid()), 15) & 1),
          1 + (get_byte(uuid_send(gen_random_uuid()), 14) & 1),
          m.carry + 2, 1, 1, v_lead, v_lead, now() + interval '20 seconds')
  returning id into v_hand;

  update card_matches set hand_no = v_no, chips1 = v_s1, chips2 = v_s2, carry = 0, next_hand_at = null
   where id = p_match;

  -- 기본 판돈으로 한쪽 칩이 0이 되면 베팅 없이 쇼다운
  if v_s1 = 0 or v_s2 = 0 then
    perform card_game.showdown(v_hand);
  end if;
  perform card_game.notify('card_match:' || p_match);
  return v_hand;
end $$;

-- ───────────── 행동 적용(검증 포함) ─────────────
-- p_player 는 players.id. 규칙 위반은 예외로 거부한다.
create function card_game.apply_action(
  p_hand uuid, p_player uuid, p_action text, p_amount int, p_auto boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare
  h card_hands%rowtype;
  m card_matches%rowtype;
  seat int;
  opp uuid;
  my_stack int; opp_stack int;
  my_c int;     opp_c int;
  to_call int;
  mx int;
  pay int;
  refund int;
  v_pot int;
  v_raise int;
  v_checks int;
  v_end text := null;
  v_logamt int := 0;
begin
  select * into h from card_hands where id = p_hand;
  select * into m from card_matches where id = h.match_id;

  if m.status <> 'playing' or h.status <> 'betting' then raise exception 'HAND_NOT_ACTIVE'; end if;
  if h.turn_player_id is distinct from p_player then raise exception 'NOT_YOUR_TURN'; end if;

  seat := case when p_player = m.player1_id then 1 else 2 end;
  opp := case when seat = 1 then m.player2_id else m.player1_id end;
  my_stack  := case when seat = 1 then m.chips1 else m.chips2 end;
  opp_stack := case when seat = 1 then m.chips2 else m.chips1 end;
  my_c  := case when seat = 1 then h.committed1 else h.committed2 end;
  opp_c := case when seat = 1 then h.committed2 else h.committed1 end;
  to_call := opp_c - my_c;
  v_pot := h.pot;
  v_raise := h.raise_count;
  v_checks := h.checks;

  if p_action = 'check' then
    if to_call <> 0 then raise exception 'CANNOT_CHECK'; end if;
    v_checks := v_checks + 1;
    if v_checks >= 2 then v_end := 'showdown'; end if;

  elsif p_action in ('bet', 'raise') then
    if (p_action = 'bet') <> (to_call = 0) then raise exception 'WRONG_ACTION'; end if;
    if v_raise >= 3 then raise exception 'RAISE_LIMIT'; end if;
    -- 최대 3칩, 내 칩(콜 금액 제외)과 상대 칩을 넘을 수 없다
    mx := least(3, my_stack - to_call, opp_stack);
    if p_amount is null or p_amount < 1 or p_amount > mx then raise exception 'BAD_AMOUNT'; end if;
    pay := to_call + p_amount;
    my_stack := my_stack - pay;
    my_c := my_c + pay;
    v_pot := v_pot + pay;
    v_raise := v_raise + 1;
    v_checks := 0;
    v_logamt := p_amount;

  elsif p_action = 'call' then
    if to_call <= 0 then raise exception 'NOTHING_TO_CALL'; end if;
    pay := least(to_call, my_stack);          -- 칩이 모자라면 남은 칩 전부로 콜(올인)
    refund := to_call - pay;                  -- 상대의 초과분은 돌려준다
    my_stack := my_stack - pay;
    my_c := my_c + pay;
    v_pot := v_pot + pay;
    if refund > 0 then
      opp_c := opp_c - refund;
      opp_stack := opp_stack + refund;
      v_pot := v_pot - refund;
    end if;
    v_logamt := pay;
    v_end := 'showdown';

  elsif p_action = 'die' then
    v_end := 'fold';

  else
    raise exception 'UNKNOWN_ACTION';
  end if;

  update card_matches
     set chips1 = case when seat = 1 then my_stack else opp_stack end,
         chips2 = case when seat = 1 then opp_stack else my_stack end
   where id = m.id;
  update card_hands
     set committed1 = case when seat = 1 then my_c else opp_c end,
         committed2 = case when seat = 1 then opp_c else my_c end,
         pot = v_pot, raise_count = v_raise, checks = v_checks,
         current_bet = case when p_action in ('bet', 'raise') then p_amount else 0 end,
         turn_player_id = opp,
         turn_deadline = now() + interval '20 seconds'
   where id = p_hand;
  insert into card_actions (hand_id, player_id, action, amount, auto)
  values (p_hand, p_player, p_action, v_logamt, p_auto);

  if v_end = 'showdown' then
    perform card_game.showdown(p_hand);
  elsif v_end = 'fold' then
    perform card_game.fold(p_hand, p_player);
  end if;
  perform card_game.notify('card_match:' || m.id);
end $$;

-- ───────────── 기권(나가기/응답 없음) ─────────────
create function card_game.forfeit(p_match uuid, p_player uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m card_matches%rowtype;
  h card_hands%rowtype;
  v_winner uuid;
begin
  select * into m from card_matches where id = p_match for update;
  if not found or m.status <> 'playing' then return; end if;
  v_winner := case when p_player = m.player1_id then m.player2_id else m.player1_id end;

  select * into h from card_hands where match_id = p_match order by hand_no desc limit 1 for update;
  if found and h.status = 'betting' then
    -- 진행 중이던 판의 판돈은 남은 사람에게
    update card_matches
       set chips1 = chips1 + case when v_winner = m.player1_id then h.pot else 0 end,
           chips2 = chips2 + case when v_winner = m.player2_id then h.pot else 0 end
     where id = p_match;
    update card_hands
       set status = 'finished', revealed = false, turn_player_id = null, turn_deadline = null, current_bet = 0,
           result = jsonb_build_object('winner_id', v_winner, 'reason', 'forfeit', 'pot', h.pot, 'carry', 0)
     where id = h.id;
  end if;
  perform card_game.finish_match(p_match, p_player);
end $$;

revoke all on all functions in schema card_game from public;
