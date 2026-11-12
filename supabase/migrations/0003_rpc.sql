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
                               'created_at', r.created_at, 'closed_at', r.closed_at),
    'participants', (select count(*) from card_players where room_id = r.id),
    'active_matches', (select count(*) from card_matches where room_id = r.id and status = 'playing'),
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

-- 내 상태: 플레이어 정보 + 진행 중인 매치(재접속 복귀용)
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
  select id into v_match from card_matches
   where status = 'playing' and (player1_id = pl.id or player2_id = pl.id)
   order by created_at desc limit 1;
  return jsonb_build_object(
    'player', jsonb_build_object('id', pl.id, 'nickname', pl.nickname, 'status', pl.status,
                                 'total_profit', pl.total_profit, 'matches_played', pl.matches_played,
                                 'matches_won', pl.matches_won, 'final_rank', pl.final_rank),
    'match_id', v_match);
end $$;

-- 연결 유지 신호 (대기 중/대결 중 응답 없음 판정에 사용)
create function public.card_heartbeat(p_room_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  update card_players set last_seen = now() where room_id = p_room_id and uid = auth.uid();
end $$;

-- ───────────── 매칭 ─────────────
-- 대기 중인 사람이 있으면 가장 먼저 대기한 사람과 1:1 매치를 만든다. 없으면 대기열에 들어간다.
create function public.card_queue_match(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  r card_rooms%rowtype;
  me card_players%rowtype;
  opp card_players%rowtype;
  v_match uuid;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('card_room:' || p_room_id::text));   -- 방 단위 매칭 직렬화

  select * into r from card_rooms where id = p_room_id;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if r.status <> 'open' then raise exception 'ROOM_CLOSED'; end if;
  select * into me from card_players where room_id = p_room_id and uid = v_uid for update;
  if not found then raise exception 'NOT_JOINED'; end if;
  update card_players set last_seen = now() where id = me.id;

  if me.status = 'playing' then
    select id into v_match from card_matches
     where status = 'playing' and (player1_id = me.id or player2_id = me.id) limit 1;
    return jsonb_build_object('status', 'matched', 'match_id', v_match);
  end if;

  -- 먼저 대기한 순. 30초 넘게 신호가 없는 대기자(탭을 닫은 사람)는 건너뛴다.
  select * into opp from card_players
   where room_id = p_room_id and status = 'queued' and id <> me.id
     and last_seen > now() - interval '30 seconds'
   order by queued_at asc, id limit 1 for update;

  if found then
    insert into card_matches (room_id, player1_id, player2_id) values (p_room_id, opp.id, me.id)
    returning id into v_match;
    update card_players set status = 'playing', queued_at = null where id in (opp.id, me.id);
    perform card_game.start_hand(v_match);
    perform card_game.notify('card_room:' || p_room_id);
    return jsonb_build_object('status', 'matched', 'match_id', v_match);
  end if;

  update card_players set status = 'queued', queued_at = coalesce(queued_at, now()) where id = me.id;
  perform card_game.notify('card_room:' || p_room_id);
  return jsonb_build_object('status', 'queued');
end $$;

create function public.card_cancel_queue(p_room_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('card_room:' || p_room_id::text));
  update card_players set status = 'idle', queued_at = null
   where room_id = p_room_id and uid = auth.uid() and status = 'queued';
  perform card_game.notify('card_room:' || p_room_id);
end $$;

-- ───────────── 카드 조회 (카드 값이 클라이언트로 가는 유일한 경로) ─────────────
-- 모드와 요청자(auth.uid())에 따라 볼 수 있는 카드만 돌려준다. 못 보는 카드는 null.
--   A 모드: 내 카드 2장 + 상대 공개 카드 1장
--   B 모드: 상대 카드 2장 (내 카드는 null)
--   쇼다운으로 끝난 판: 양쪽 전부 (다이로 끝난 판은 공개하지 않는다)
-- p_hand_no 가 null 이면 가장 최근 판.
create function public.card_get_visible_hand(p_match_id uuid, p_hand_no int default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  m card_matches%rowtype;
  h card_hands%rowtype;
  r card_rooms%rowtype;
  seat int;
  mine int[]; theirs int[];
  my_open int; opp_open int;
  v_me int[]; v_opp int[];
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into m from card_matches where id = p_match_id;
  if not found then raise exception 'MATCH_NOT_FOUND'; end if;
  if exists (select 1 from card_players where id = m.player1_id and uid = v_uid) then seat := 1;
  elsif exists (select 1 from card_players where id = m.player2_id and uid = v_uid) then seat := 2;
  else raise exception 'NOT_A_PLAYER'; end if;

  select * into r from card_rooms where id = m.room_id;
  select * into h from card_hands
   where match_id = p_match_id and (p_hand_no is null or hand_no = p_hand_no)
   order by hand_no desc limit 1;
  if not found then return null; end if;

  mine     := case when seat = 1 then h.cards1 else h.cards2 end;
  theirs   := case when seat = 1 then h.cards2 else h.cards1 end;
  my_open  := case when seat = 1 then h.open1 else h.open2 end;
  opp_open := case when seat = 1 then h.open2 else h.open1 end;

  if h.revealed then
    v_me := mine;
    v_opp := theirs;
  elsif r.mode = 'A' then
    v_me := mine;
    v_opp := array[case when opp_open = 1 then theirs[1] end, case when opp_open = 2 then theirs[2] end];
  else
    v_me := array[null, null]::int[];
    v_opp := theirs;
  end if;

  return jsonb_build_object(
    'hand_id', h.id, 'hand_no', h.hand_no, 'mode', r.mode, 'seat', seat, 'revealed', h.revealed,
    'me', to_jsonb(v_me), 'opp', to_jsonb(v_opp),
    'me_open',  case when r.mode = 'A' then my_open end,
    'opp_open', case when r.mode = 'A' then opp_open end);
end $$;

-- 카드를 제외한 매치 상태(칩, 판돈, 차례, 행동 로그). 카드 컬럼은 읽지 않는다.
create function public.card_get_match_state(p_match_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  m card_matches%rowtype;
  h card_hands%rowtype;
  r card_rooms%rowtype;
  p1 card_players%rowtype;
  p2 card_players%rowtype;
  seat int;
  v_hand jsonb := null;
  v_actions jsonb := '[]'::jsonb;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into m from card_matches where id = p_match_id;
  if not found then raise exception 'MATCH_NOT_FOUND'; end if;
  select * into p1 from card_players where id = m.player1_id;
  select * into p2 from card_players where id = m.player2_id;
  if p1.uid = v_uid then seat := 1; elsif p2.uid = v_uid then seat := 2;
  else raise exception 'NOT_A_PLAYER'; end if;
  select * into r from card_rooms where id = m.room_id;

  select * into h from card_hands where match_id = p_match_id order by hand_no desc limit 1;
  if found then
    v_hand := jsonb_build_object(
      'id', h.id, 'hand_no', h.hand_no, 'status', h.status, 'pot', h.pot, 'current_bet', h.current_bet,
      'committed1', h.committed1, 'committed2', h.committed2,
      'lead_player_id', h.lead_player_id, 'turn_player_id', h.turn_player_id,
      'raise_count', h.raise_count, 'checks', h.checks,
      'turn_deadline', h.turn_deadline, 'result', h.result);
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', a.id, 'player_id', a.player_id, 'action', a.action, 'amount', a.amount,
             'auto', a.auto, 'created_at', a.created_at) order by a.id), '[]'::jsonb)
      into v_actions from card_actions a where a.hand_id = h.id;
  end if;

  return jsonb_build_object(
    'server_now', now(),
    'seat', seat,
    'match', jsonb_build_object(
      'id', m.id, 'room_id', m.room_id, 'room_status', r.status, 'mode', r.mode, 'status', m.status,
      'hand_no', m.hand_no, 'max_hands', 5, 'chips1', m.chips1, 'chips2', m.chips2, 'carry', m.carry,
      'player1', jsonb_build_object('id', p1.id, 'nickname', p1.nickname),
      'player2', jsonb_build_object('id', p2.id, 'nickname', p2.nickname),
      'winner_id', m.winner_id, 'end_reason', m.end_reason,
      'profit1', m.profit1, 'profit2', m.profit2, 'next_hand_at', m.next_hand_at),
    'hand', v_hand,
    'actions', v_actions);
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

  select p.id into v_pl from card_players p join card_matches m on p.id in (m.player1_id, m.player2_id)
   where m.id = v_match and p.uid = v_uid;
  if v_pl is null then raise exception 'NOT_A_PLAYER'; end if;

  -- 시간이 지났으면 클라이언트 행동 대신 timeout_check 가 처리한다 (1초 여유)
  if h.status = 'betting' and h.turn_deadline is not null and now() > h.turn_deadline + interval '1 second' then
    raise exception 'TURN_EXPIRED';
  end if;

  perform card_game.apply_action(p_hand_id, v_pl, p_action, coalesce(p_amount, 0), false);
  update card_players set last_seen = now() where id = v_pl;
  return jsonb_build_object('ok', true);
end $$;

-- 시간 초과 처리: 상대가 60초 넘게 응답이 없으면 기권 처리, 20초 턴이 지났으면 자동 행동(체크/다이).
-- 참가자 누구나 호출 가능하며 서버가 조건을 검증하므로 멱등적이다.
create function public.card_timeout_check(p_hand_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_match uuid;
  h card_hands%rowtype;
  m card_matches%rowtype;
  v_seen timestamptz;
  v_caller uuid;
  v_action text;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select match_id into v_match from card_hands where id = p_hand_id;
  if v_match is null then raise exception 'HAND_NOT_FOUND'; end if;
  select * into m from card_matches where id = v_match for update;
  select * into h from card_hands where id = p_hand_id for update;

  select p.id into v_caller from card_players p
   where p.uid = v_uid and p.id in (m.player1_id, m.player2_id);
  if v_caller is null then raise exception 'NOT_A_PLAYER'; end if;
  update card_players set last_seen = now() where id = v_caller;

  if m.status <> 'playing' or h.status <> 'betting' then
    return jsonb_build_object('result', 'noop');
  end if;

  select last_seen into v_seen from card_players where id = h.turn_player_id;
  if v_seen < now() - interval '60 seconds' then
    perform card_game.forfeit(v_match, h.turn_player_id);
    return jsonb_build_object('result', 'forfeit');
  end if;

  if now() >= h.turn_deadline then
    v_action := case when h.committed1 = h.committed2 then 'check' else 'die' end;
    perform card_game.apply_action(p_hand_id, h.turn_player_id, v_action, 0, true);
    return jsonb_build_object('result', 'auto', 'action', v_action);
  end if;
  return jsonb_build_object('result', 'noop');
end $$;

-- 판이 끝나고 연출 시간(next_hand_at)이 지났으면 다음 판을 시작한다. 멱등.
-- 연출 중에 상대가 60초 넘게 사라졌으면 기권 처리한다.
create function public.card_advance_match(p_match_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  m card_matches%rowtype;
  v_caller uuid;
  v_opp uuid;
  v_seen timestamptz;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into m from card_matches where id = p_match_id for update;
  if not found then raise exception 'MATCH_NOT_FOUND'; end if;
  select p.id into v_caller from card_players p where p.uid = v_uid and p.id in (m.player1_id, m.player2_id);
  if v_caller is null then raise exception 'NOT_A_PLAYER'; end if;
  update card_players set last_seen = now() where id = v_caller;

  if m.status <> 'playing' or m.next_hand_at is null then return jsonb_build_object('result', 'noop'); end if;

  v_opp := case when v_caller = m.player1_id then m.player2_id else m.player1_id end;
  select last_seen into v_seen from card_players where id = v_opp;
  if v_seen < now() - interval '60 seconds' then
    perform card_game.forfeit(p_match_id, v_opp);
    return jsonb_build_object('result', 'forfeit');
  end if;

  if now() < m.next_hand_at then return jsonb_build_object('result', 'wait'); end if;
  perform card_game.start_hand(p_match_id);
  return jsonb_build_object('result', 'started');
end $$;

-- 나가기 = 기권. 남은 사람의 승리로 처리한다.
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
  select p.id into v_pl from card_players p where p.uid = v_uid and p.id in (m.player1_id, m.player2_id);
  if v_pl is null then raise exception 'NOT_A_PLAYER'; end if;
  perform card_game.forfeit(p_match_id, v_pl);
end $$;

-- ───────────── 방 관리 (생성자 전용) ─────────────
create function public.card_verify_admin(p_room_id uuid, p_admin_token text)
returns boolean language sql security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from card_rooms
     where id = p_room_id
       and admin_token_hash = encode(sha256(convert_to(coalesce(p_admin_token, ''), 'UTF8')), 'hex'));
$$;

-- 방 종료: 진행 중 매치는 무효 처리(수익 반영 없음), 최종 순위를 확정한다.
create function public.card_close_room(p_room_id uuid, p_admin_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_m uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.card_verify_admin(p_room_id, p_admin_token) then raise exception 'FORBIDDEN'; end if;
  perform pg_advisory_xact_lock(hashtext('card_room:' || p_room_id::text));

  update card_rooms set status = 'closed', closed_at = now() where id = p_room_id and status = 'open';

  for v_m in select id from card_matches where room_id = p_room_id and status = 'playing' for update loop
    update card_hands set status = 'void', turn_player_id = null, turn_deadline = null
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
  public.card_get_room_view(uuid),
  public.card_join_room(uuid, text),
  public.card_my_status(uuid),
  public.card_heartbeat(uuid),
  public.card_queue_match(uuid),
  public.card_cancel_queue(uuid),
  public.card_get_visible_hand(uuid, int),
  public.card_get_match_state(uuid),
  public.card_act(uuid, text, int),
  public.card_timeout_check(uuid),
  public.card_advance_match(uuid),
  public.card_leave_match(uuid),
  public.card_verify_admin(uuid, text),
  public.card_close_room(uuid, text)
from public, anon, authenticated;

grant execute on function
  public.card_create_room(text, text),
  public.card_get_room_view(uuid),
  public.card_join_room(uuid, text),
  public.card_my_status(uuid),
  public.card_heartbeat(uuid),
  public.card_queue_match(uuid),
  public.card_cancel_queue(uuid),
  public.card_get_visible_hand(uuid, int),
  public.card_get_match_state(uuid),
  public.card_act(uuid, text, int),
  public.card_timeout_check(uuid),
  public.card_advance_match(uuid),
  public.card_leave_match(uuid),
  public.card_verify_admin(uuid, text),
  public.card_close_room(uuid, text)
to authenticated;
