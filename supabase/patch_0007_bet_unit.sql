-- ⚠️ 수동 패치 (마이그레이션 아님): 베팅 단위 = 앤티(판 번호). patch_0005, patch_0006 을 먼저 실행한 DB 에서 한 번 실행하세요.
-- 새로 0001~0004 를 실행하는 경우에는 필요 없습니다 (이미 반영되어 있음).
--
-- 변경: 베팅/레이즈 금액이 1~3칸(1칸 = 앤티 = 판 번호)의 배수만 가능 (칩이 모자라면 올인 금액도 가능).
-- 이 게임의 card_game.apply_action 한 개만 교체한다(실행 권한 유지). 다른 게임의 객체는 건드리지 않는다.

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
    -- 베팅 1칸 = 앤티 = 판 번호. 최대 3칸, 가진 칩(콜 금액 제외)을 넘을 수 없다.
    -- 금액은 앤티의 배수여야 하고, 칩이 모자라면 남은 칩 전부(올인)도 가능하다.
    mx := least(3 * h.hand_no, my_stack - to_call);
    if p_amount is null or p_amount < 1 or p_amount > mx
       or (p_amount % h.hand_no <> 0 and p_amount <> my_stack - to_call) then raise exception 'BAD_AMOUNT'; end if;
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
