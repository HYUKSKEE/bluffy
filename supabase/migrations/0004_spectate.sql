-- 0004: 관전 (읽기 전용)
-- 새 함수만 추가한다. 기존 card_* 함수/테이블/다른 게임 객체는 건드리지 않는다.
--
-- 관전자가 보는 것: 좌석·칩·판돈·차례·행동 로그 + "이번 판에 참여 중인 모든 좌석의 카드"(seat_cards).
-- 관전자는 참가자가 아니므로 행동할 수 없다. (주의: 관전자가 참가자에게 카드를 몰래 알려주면 부정행위가 되므로
--  README 의 '관전' 항목에 이 점을 명시했다.)

-- 방에서 진행 중/대기 중인 테이블 목록 (관전 진입용)
create function public.card_list_tables(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  perform 1 from card_players where room_id = p_room_id and uid = v_uid;
  if not found then raise exception 'NOT_JOINED'; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'match_id', m.id, 'status', m.status, 'hand_no', m.hand_no, 'max_hands', m.max_hands,
             'seats', (select count(*) from card_match_players x where x.match_id = m.id and not x.left_match),
             'host', (select p.nickname from card_players p where p.id = m.host_player_id),
             'players', (select jsonb_agg(p.nickname order by x.seat)
                           from card_match_players x join card_players p on p.id = x.player_id
                          where x.match_id = m.id and not x.left_match))
           order by m.created_at)
      from card_matches m
     where m.room_id = p_room_id and m.status in ('waiting', 'playing')
  ), '[]'::jsonb);
end $$;

-- 관전용 상태: card_get_match_state 와 같은 모양 + 이번 판 참여 좌석의 카드(seat_cards)
create function public.card_spectate_match(p_match_id uuid)
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
    select coalesce(jsonb_agg(jsonb_build_object('seat', hs.seat, 'cards', to_jsonb(hs.cards)) order by hs.seat), '[]'::jsonb)
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

-- 이 파일의 함수 두 개에만 권한을 준다 (다른 객체의 권한은 건드리지 않음)
revoke all on function public.card_list_tables(uuid), public.card_spectate_match(uuid) from public, anon, authenticated;
grant execute on function public.card_list_tables(uuid), public.card_spectate_match(uuid) to authenticated;
