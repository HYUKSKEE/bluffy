-- ⚠️ 수동 패치 (마이그레이션 아님): 다이한 사람은 상대의 패를 볼 수 없다 (판이 끝난 뒤에도).
-- 끝까지 남은 사람은 판이 끝나면 그 판 참여자 전원의 패를 본다.
-- 이미 0001~0004 를 실행한 DB 에서 한 번 실행하세요. 새로 0001~0004 를 실행하는 경우에는 필요 없습니다.
-- card_get_visible_hand 한 함수만 교체한다(실행 권한 유지). 다른 게임의 객체는 건드리지 않는다.

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

  -- 다이한 사람은 상대의 패를 볼 수 없다. 판이 끝난 뒤에도 마찬가지다
  -- (끝까지 남은 사람만 공개된 패를 본다. 본 정보를 남에게 알려주는 것 방지).
  v_out := exists (select 1 from card_hand_seats x where x.hand_id = h.id and x.seat = v_my_seat and x.folded);

  for hs in select * from card_hand_seats where hand_id = h.id order by seat loop
    if hs.seat = v_my_seat then
      -- 내 카드: 판이 끝나면 공개, 진행 중에는 모드 규칙 (A: 보임, B: 안 보임)
      v_cards := case when h.revealed and hs.in_hand then hs.cards
                      when r.mode = 'A' then hs.cards
                      else array[null, null]::int[] end;
    elsif v_out then
      v_cards := array[null, null]::int[];                              -- 다이한 사람: 상대 패는 끝까지 안 보인다
    elsif h.revealed and hs.in_hand then
      v_cards := hs.cards;                                              -- 판이 끝나면 남은 사람에게 그 판 참여자 전원의 패를 공개
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
