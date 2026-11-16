-- ⚠️ 수동 패치 (마이그레이션 아님): 닉네임 변경. 이미 0001~0004 를 실행한 DB 에서 한 번 실행하세요.
-- 새로 0001~0004 를 실행하는 경우에는 필요 없습니다 (이미 반영되어 있음).
-- 새 함수 card_rename_player 하나만 만든다. 다른 게임의 객체는 건드리지 않는다.

create or replace function public.card_rename_player(p_room_id uuid, p_nickname text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_nick text := btrim(regexp_replace(coalesce(p_nickname, ''), '\s+', ' ', 'g'));
  r card_rooms%rowtype;
  pl card_players%rowtype;
  v_m uuid;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into r from card_rooms where id = p_room_id;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if r.status <> 'open' then raise exception 'ROOM_CLOSED'; end if;
  select * into pl from card_players where room_id = p_room_id and uid = v_uid;
  if not found then raise exception 'NOT_JOINED'; end if;
  if char_length(v_nick) < 1 or char_length(v_nick) > 12 then raise exception 'BAD_NICKNAME'; end if;

  if exists (select 1 from card_match_players mp join card_matches m on m.id = mp.match_id
              where mp.player_id = pl.id and not mp.left_match and m.status = 'playing') then
    raise exception 'IN_MATCH';
  end if;

  begin
    update card_players set nickname = v_nick, last_seen = now() where id = pl.id returning * into pl;
  exception when unique_violation then
    raise exception 'NICKNAME_TAKEN';
  end;

  -- 대기 테이블에 앉아 있으면 그 화면도 갱신
  for v_m in select mp.match_id from card_match_players mp join card_matches m on m.id = mp.match_id
              where mp.player_id = pl.id and m.status = 'waiting' loop
    perform card_game.notify('card_match:' || v_m);
  end loop;
  perform card_game.notify('card_room:' || p_room_id);
  return jsonb_build_object('id', pl.id, 'nickname', pl.nickname, 'status', pl.status,
                            'total_profit', pl.total_profit, 'matches_played', pl.matches_played,
                            'matches_won', pl.matches_won, 'final_rank', pl.final_rank);
end $$;

revoke all on function public.card_rename_player(uuid, text) from public, anon, authenticated;
grant execute on function public.card_rename_player(uuid, text) to authenticated;
