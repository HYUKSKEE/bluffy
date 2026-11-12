-- ⚠️ 수동 패치 (마이그레이션 아님). 0002/0003 을 "이미" 실행한 DB 에만 한 번 실행하세요.
-- 새로 0001~0004 를 실행하는 경우에는 필요 없습니다 (이미 반영되어 있음).
--
-- 변경: 한 판이 끝나면(쇼다운이든 모두 다이든) 그 판에 참여한 모든 좌석의 패를 공개한다.
-- 이 게임의 card_game.close_hand / card_game.settle_fold / public.card_get_visible_hand 세 함수만 교체한다.
-- 다른 게임의 객체는 건드리지 않는다.

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

