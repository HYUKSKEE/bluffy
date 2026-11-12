-- 0003_rpc.sql : 클라이언트가 호출하는 RPC (전부 security definer, auth.uid() 기준)
-- 클라이언트의 모든 읽기/쓰기는 여기를 통해서만 이루어진다.

-- ───────────── 방 ─────────────
-- 반환: { room_id, admin_token }  (admin_token 원문은 이 응답에서만 볼 수 있고 DB엔 해시만 남는다)
create function public.card_create_room(p_title text, p_mode text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if char_length(v_title) < 1 or char_length(v_title) > 40 then raise exception 'BAD_TITLE'; end if;
  if p_mode not in ('A', 'B') then raise exception 'BAD_MODE'; end if;
  insert into card_rooms (title, mode, admin_token_hash)
  values (v_title, p_mode, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'))
  returning id into v_id;
  return jsonb_build_object('room_id', v_id, 'admin_token', v_token);
end $$;

-- 고난이도(덱 순환) 옵션을 함께 정하는 방 만들기. card_create_room 을 그대로 호출한 뒤 옵션 행만 추가한다.
create function public.card_create_room_ex(p_title text, p_mode text, p_hard boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res jsonb := public.card_create_room(p_title, p_mode);
begin
  insert into card_room_options (room_id, hard) values ((v_res->>'room_id')::uuid, coalesce(p_hard, false));
  return v_res;
end $$;

-- 방 정보 + 랭킹 (링크를 아는 사람에게 공개). uid 는 노출하지 않는다.
create function public.card_get_room_view(p_room_id uuid)
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
                               'hard', coalesce((select o.hard from card_room_options o where o.room_id = r.id), false)),
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

-- 입장(닉네임 등록). 같은 익명 계정이 다시 들어오면 기존 플레이어를 돌려준다.
create function public.card_join_room(p_room_id uuid, p_nickname text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_nick text := btrim(regexp_replace(coalesce(p_nickname, ''), '\s+', ' ', 'g'));
  r card_rooms%rowtype;
  pl card_players%rowtype;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into r from card_rooms where id = p_room_id;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;

  select * into pl from card_players where room_id = p_room_id and uid = v_uid;
  if not found then
    if r.status <> 'open' then raise exception 'ROOM_CLOSED'; end if;
    if char_length(v_nick) < 1 or char_length(v_nick) > 12 then raise exception 'BAD_NICKNAME'; end if;
    if (select count(*) from card_players where room_id = p_room_id) >= 200 then raise exception 'ROOM_FULL'; end if;
    begin
      insert into card_players (room_id, uid, nickname) values (p_room_id, v_uid, v_nick) returning * into pl;
    exception when unique_violation then
      raise exception 'NICKNAME_TAKEN';
    end;
    perform card_game.notify('card_room:' || p_room_id);
  else
    update card_players set last_seen = now() where id = pl.id returning * into pl;
  end if;
  return jsonb_build_object('id', pl.id, 'nickname', pl.nickname, 'status', pl.status,
                            'total_profit', pl.total_profit, 'matches_played', pl.matches_played,
                            'matches_won', pl.matches_won, 'final_rank', pl.final_rank);
end $$;

-- 내 상태: 플레이어 정보 + 앉아 있는 테이블(대기 중이거나 진행 중, 재접속 복귀용)
create function public.card_my_status(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  pl card_players%rowtype;
  v_match uuid;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  update card_players set last_seen = now() where room_id = p_room_id and uid = v_uid returning * into pl;
  if not found then return jsonb_build_object('player', null, 'match_id', null); end if;
  select mt.id into v_match
    from card_matches mt join card_match_players mp on mp.match_id = mt.id
   where mp.player_id = pl.id and not mp.left_match and mt.status in ('waiting', 'playing')
   order by mt.created_at desc limit 1;
  return jsonb_build_object(
    'player', jsonb_build_object('id', pl.id, 'nickname', pl.nickname, 'status', pl.status,
                                 'total_profit', pl.total_profit, 'matches_played', pl.matches_played,
                                 'matches_won', pl.matches_won, 'final_rank', pl.final_rank),
    'match_id', v_match);
end $$;

-- 연결 유지 신호 (대기/대결 중 응답 없음 판정에 사용). 대기 테이블의 유령 좌석도 정리한다.
create function public.card_heartbeat(p_room_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  update card_players set last_seen = now() where room_id = p_room_id and uid = auth.uid();
  perform card_game.prune_waiting(p_room_id);
end $$;

-- ───────────── 테이블 (대기 → 시작) ─────────────
-- 대결 찾기: 가장 먼저 열린 대기 테이블(5명 미만)에 앉는다. 없으면 새 테이블을 열고 내가 방장이 된다.
-- 5명이 모이면 자동으로 시작한다. 반환: { status: waiting | playing, match_id }
create function public.card_queue_match(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  r card_rooms%rowtype;
  me card_players%rowtype;
  v_match uuid;
  v_status text;
  v_seat int;
  v_count int;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('card_room:' || p_room_id::text));   -- 방 단위 직렬화

  select * into r from card_rooms where id = p_room_id;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if r.status <> 'open' then raise exception 'ROOM_CLOSED'; end if;
  select * into me from card_players where room_id = p_room_id and uid = v_uid for update;
  if not found then raise exception 'NOT_JOINED'; end if;
  update card_players set last_seen = now() where id = me.id;

  -- 이미 앉아 있으면 그 테이블로 복귀
  select mt.id, mt.status into v_match, v_status
    from card_matches mt join card_match_players mp on mp.match_id = mt.id
   where mp.player_id = me.id and not mp.left_match and mt.status in ('waiting', 'playing') limit 1;
  if v_match is not null then
    return jsonb_build_object('status', v_status, 'match_id', v_match);
  end if;

  perform card_game.prune_waiting(p_room_id);

  select mt.id into v_match from card_matches mt
   where mt.room_id = p_room_id and mt.status = 'waiting'
     and (select count(*) from card_match_players where match_id = mt.id) < 5
   order by mt.created_at, mt.id limit 1;
  if v_match is null then
    insert into card_matches (room_id, host_player_id) values (p_room_id, me.id) returning id into v_match;
  end if;

  select min(s) into v_seat from generate_series(1, 5) s
   where not exists (select 1 from card_match_players where match_id = v_match and seat = s);
  insert into card_match_players (match_id, seat, player_id) values (v_match, v_seat, me.id);
  update card_players set status = 'queued', queued_at = now() where id = me.id;

  select count(*) into v_count from card_match_players where match_id = v_match;
  if v_count >= 5 then
    perform card_game.begin_match(v_match);
    v_status := 'playing';
  else
    v_status := 'waiting';
  end if;
  perform card_game.notify('card_match:' || v_match);
  perform card_game.notify('card_room:' || p_room_id);
  return jsonb_build_object('status', v_status, 'match_id', v_match);
end $$;

-- 방장이 마음대로 시작한다 (2명 이상). 5명이 되면 자동 시작되므로 그 전에 시작하고 싶을 때 쓴다.
create function public.card_start_match(p_match_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  m card_matches%rowtype;
  v_caller uuid;
  v_count int;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into m from card_matches where id = p_match_id;
  if not found then raise exception 'MATCH_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtext('card_room:' || m.room_id::text));
  select * into m from card_matches where id = p_match_id for update;

  select p.id into v_caller from card_players p
    join card_match_players mp on mp.player_id = p.id and mp.match_id = m.id
   where p.uid = v_uid and not mp.left_match;
  if v_caller is null then raise exception 'NOT_A_PLAYER'; end if;
  if m.host_player_id <> v_caller then raise exception 'NOT_HOST'; end if;
  if m.status <> 'waiting' then raise exception 'ALREADY_STARTED'; end if;

  update card_players set last_seen = now() where id = v_caller;
  perform card_game.prune_waiting(m.room_id);
  select count(*) into v_count from card_match_players where match_id = m.id;
  if v_count < 2 then raise exception 'NOT_ENOUGH_PLAYERS'; end if;

  perform card_game.begin_match(m.id);
  return jsonb_build_object('status', 'playing', 'match_id', m.id);
end $$;

-- 나가기. 대기 중이면 자리를 비우고(방장이면 방장 위임), 진행 중이면 기권한다.
create function public.card_leave_match(p_match_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  m card_matches%rowtype;
  v_pl uuid;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into m from card_matches where id = p_match_id for update;
  if not found then raise exception 'MATCH_NOT_FOUND'; end if;
  select p.id into v_pl from card_players p
    join card_match_players mp on mp.player_id = p.id and mp.match_id = m.id
   where p.uid = v_uid;
  if v_pl is null then raise exception 'NOT_A_PLAYER'; end if;
  if m.status = 'waiting' then
    perform card_game.remove_waiting_seat(m.id, v_pl);
  elsif m.status = 'playing' then
    perform card_game.forfeit(m.id, v_pl);
  end if;
end $$;

-- ───────────── 카드 조회 (카드 값이 클라이언트로 가는 유일한 경로) ─────────────
-- 모드와 요청자(auth.uid())에 따라 볼 수 있는 카드만 돌려준다. 못 보는 카드는 null.
--   A 모드: 내 카드 2장 + 각 상대의 공개 카드 1장
--   B 모드: 모든 상대의 카드 2장 (내 카드는 null)
--   쇼다운으로 끝난 판: 생존자(다이 안 한 사람)의 카드는 전부 공개 (다이로 끝난 판은 공개하지 않는다)
-- p_hand_no 가 null 이면 가장 최근 판.
create function public.card_get_visible_hand(p_match_id uuid, p_hand_no int default null)
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

-- 카드를 제외한 매치 상태(좌석, 칩, 판돈, 차례, 행동 로그). 카드 컬럼은 읽지 않는다.
create function public.card_get_match_state(p_match_id uuid)
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
      'host_player_id', m.host_player_id, 'end_reason', m.end_reason, 'next_hand_at', m.next_hand_at),
    'seats', v_seats,
    'hand', v_hand,
    'actions', v_actions,
    'pile', card_game.deck_info(m.id));
end $$;

-- ───────────── 행동 ─────────────
-- p_action: check | bet | raise | call | die.  p_amount: bet/raise 에서만 사용(1~3).
-- 차례·금액·레이즈 횟수는 전부 서버에서 검증한다. 위반하면 예외(HAND_NOT_ACTIVE, NOT_YOUR_TURN, ...).
create function public.card_act(p_hand_id uuid, p_action text, p_amount int default 0)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_match uuid;
  v_pl uuid;
  h card_hands%rowtype;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select match_id into v_match from card_hands where id = p_hand_id;
  if v_match is null then raise exception 'HAND_NOT_FOUND'; end if;
  perform 1 from card_matches where id = v_match for update;           -- 잠금 순서: matches → hands
  select * into h from card_hands where id = p_hand_id for update;

  select p.id into v_pl from card_players p
    join card_match_players mp on mp.player_id = p.id and mp.match_id = v_match
   where p.uid = v_uid and not mp.left_match;
  if v_pl is null then raise exception 'NOT_A_PLAYER'; end if;

  -- 시간이 지났으면 클라이언트 행동 대신 timeout_check 가 처리한다 (1초 여유)
  if h.status = 'betting' and h.turn_deadline is not null and now() > h.turn_deadline + interval '1 second' then
    raise exception 'TURN_EXPIRED';
  end if;

  perform card_game.apply_action(p_hand_id, v_pl, p_action, coalesce(p_amount, 0), false);
  update card_players set last_seen = now() where id = v_pl;
  return jsonb_build_object('ok', true);
end $$;

-- 시간 초과 처리: 60초 넘게 응답이 없는 사람은 기권 처리, 20초 턴이 지났으면 자동 행동(체크/다이).
-- 참가자 누구나 호출 가능하며 서버가 조건을 검증하므로 멱등적이다.
create function public.card_timeout_check(p_hand_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_match uuid;
  h card_hands%rowtype;
  m card_matches%rowtype;
  v_caller uuid;
  v_turn_player uuid;
  v_my_c int;
  v_action text;
  v_forfeit boolean := false;
  s record;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select match_id into v_match from card_hands where id = p_hand_id;
  if v_match is null then raise exception 'HAND_NOT_FOUND'; end if;
  select * into m from card_matches where id = v_match for update;
  select * into h from card_hands where id = p_hand_id for update;

  select p.id into v_caller from card_players p
    join card_match_players mp on mp.player_id = p.id and mp.match_id = v_match
   where p.uid = v_uid;
  if v_caller is null then raise exception 'NOT_A_PLAYER'; end if;
  update card_players set last_seen = now() where id = v_caller;

  if m.status <> 'playing' then return jsonb_build_object('result', 'noop'); end if;

  -- 60초 넘게 응답이 없는 사람은 기권 처리 (진행 중인 판에서는 다이)
  for s in
    select mp.player_id from card_match_players mp join card_players p on p.id = mp.player_id
     where mp.match_id = v_match and not mp.left_match and p.id <> v_caller
       and p.last_seen < now() - interval '60 seconds'
  loop
    perform card_game.forfeit(v_match, s.player_id);
    v_forfeit := true;
  end loop;

  select * into m from card_matches where id = v_match;
  select * into h from card_hands where id = p_hand_id;
  if m.status <> 'playing' or h.status <> 'betting' then
    return jsonb_build_object('result', case when v_forfeit then 'forfeit' else 'noop' end);
  end if;

  if now() >= h.turn_deadline then
    select mp.player_id into v_turn_player from card_match_players mp where mp.match_id = v_match and mp.seat = h.turn_seat;
    select committed into v_my_c from card_hand_seats where hand_id = h.id and seat = h.turn_seat;
    v_action := case when h.level = v_my_c then 'check' else 'die' end;
    perform card_game.apply_action(p_hand_id, v_turn_player, v_action, 0, true);
    return jsonb_build_object('result', 'auto', 'action', v_action);
  end if;
  return jsonb_build_object('result', case when v_forfeit then 'forfeit' else 'noop' end);
end $$;

-- 판이 끝나고 연출 시간(next_hand_at)이 지났으면 다음 판을 시작한다. 멱등.
-- 연출 중에 60초 넘게 사라진 사람은 기권 처리한다.
create function public.card_advance_match(p_match_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  m card_matches%rowtype;
  v_caller uuid;
  v_forfeit boolean := false;
  s record;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into m from card_matches where id = p_match_id for update;
  if not found then raise exception 'MATCH_NOT_FOUND'; end if;
  select p.id into v_caller from card_players p
    join card_match_players mp on mp.player_id = p.id and mp.match_id = m.id
   where p.uid = v_uid;
  if v_caller is null then raise exception 'NOT_A_PLAYER'; end if;
  update card_players set last_seen = now() where id = v_caller;

  if m.status <> 'playing' then return jsonb_build_object('result', 'noop'); end if;

  for s in
    select mp.player_id from card_match_players mp join card_players p on p.id = mp.player_id
     where mp.match_id = m.id and not mp.left_match and p.id <> v_caller
       and p.last_seen < now() - interval '60 seconds'
  loop
    perform card_game.forfeit(m.id, s.player_id);
    v_forfeit := true;
  end loop;

  select * into m from card_matches where id = p_match_id;
  if m.status <> 'playing' or m.next_hand_at is null then
    return jsonb_build_object('result', case when v_forfeit then 'forfeit' else 'noop' end);
  end if;
  if now() < m.next_hand_at then return jsonb_build_object('result', 'wait'); end if;
  perform card_game.start_hand(p_match_id);
  return jsonb_build_object('result', 'started');
end $$;

-- ───────────── 방 관리 (생성자 전용) ─────────────
create function public.card_verify_admin(p_room_id uuid, p_admin_token text)
returns boolean language sql security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from card_rooms
     where id = p_room_id
       and admin_token_hash = encode(sha256(convert_to(coalesce(p_admin_token, ''), 'UTF8')), 'hex'));
$$;

-- 방 종료: 대기/진행 중 테이블은 무효 처리(수익 반영 없음), 최종 순위를 확정한다.
create function public.card_close_room(p_room_id uuid, p_admin_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_m uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.card_verify_admin(p_room_id, p_admin_token) then raise exception 'FORBIDDEN'; end if;
  perform pg_advisory_xact_lock(hashtext('card_room:' || p_room_id::text));

  update card_rooms set status = 'closed', closed_at = now() where id = p_room_id and status = 'open';

  for v_m in select id from card_matches where room_id = p_room_id and status in ('waiting', 'playing') for update loop
    update card_hands set status = 'void', turn_seat = null, turn_deadline = null
     where match_id = v_m and status = 'betting';
    update card_matches set status = 'void', end_reason = 'void', next_hand_at = null where id = v_m;
    perform card_game.notify('card_match:' || v_m);
  end loop;
  update card_players set status = 'idle', queued_at = null where room_id = p_room_id;

  update card_players p set final_rank = s.rn
    from (select id, row_number() over (order by total_profit desc, matches_won desc, joined_at asc, id) as rn
            from card_players where room_id = p_room_id) s
   where p.id = s.id;

  perform card_game.notify('card_room:' || p_room_id);
  return jsonb_build_object('ok', true);
end $$;

-- ───────────── 실행 권한 ─────────────
-- 함수는 기본적으로 PUBLIC(및 Supabase 기본 권한으로 anon)에 실행 권한이 열려 있으므로,
-- 이 마이그레이션이 만든 card_ 함수만 하나씩 회수한 뒤 authenticated(익명 로그인 포함)에만 연다.
-- 스키마 전체에 대한 revoke/grant 는 쓰지 않는다 (같은 프로젝트의 다른 게임 RPC 를 건드리지 않기 위함).
revoke execute on function
  public.card_create_room(text, text),
  public.card_create_room_ex(text, text, boolean),
  public.card_get_room_view(uuid),
  public.card_join_room(uuid, text),
  public.card_my_status(uuid),
  public.card_heartbeat(uuid),
  public.card_queue_match(uuid),
  public.card_start_match(uuid),
  public.card_leave_match(uuid),
  public.card_get_visible_hand(uuid, int),
  public.card_get_match_state(uuid),
  public.card_act(uuid, text, int),
  public.card_timeout_check(uuid),
  public.card_advance_match(uuid),
  public.card_verify_admin(uuid, text),
  public.card_close_room(uuid, text)
from public, anon, authenticated;

grant execute on function
  public.card_create_room(text, text),
  public.card_create_room_ex(text, text, boolean),
  public.card_get_room_view(uuid),
  public.card_join_room(uuid, text),
  public.card_my_status(uuid),
  public.card_heartbeat(uuid),
  public.card_queue_match(uuid),
  public.card_start_match(uuid),
  public.card_leave_match(uuid),
  public.card_get_visible_hand(uuid, int),
  public.card_get_match_state(uuid),
  public.card_act(uuid, text, int),
  public.card_timeout_check(uuid),
  public.card_advance_match(uuid),
  public.card_verify_admin(uuid, text),
  public.card_close_room(uuid, text)
to authenticated;
