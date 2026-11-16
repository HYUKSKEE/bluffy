-- ⚠️ 수동 패치 (마이그레이션 아님): 이모지 "스겜!" 추가. patch_0011 을 먼저 실행한 DB 에서 한 번 실행하세요.
-- 새로 0001~0004 를 실행하는 경우에는 필요 없습니다 (이미 반영되어 있음).
-- card_send_emote 한 함수만 교체한다(실행 권한 유지). 다른 게임의 객체는 건드리지 않는다.

create or replace function public.card_send_emote(p_match_id uuid, p_emote text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_who jsonb;
  v_id bigint;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_emote is null or p_emote not in ('ugh', 'taunt', 'yes', 'sad', 'sg') then raise exception 'BAD_EMOTE'; end if;
  v_who := card_game.chat_channel(p_match_id, v_uid);
  if (select count(*) from card_chat_messages
       where match_id = p_match_id and player_id = (v_who->>'player_id')::uuid
         and created_at > now() - interval '10 seconds') >= 5 then
    raise exception 'CHAT_RATE';
  end if;
  insert into card_chat_messages (match_id, channel, player_id, body)
  values (p_match_id, v_who->>'channel', (v_who->>'player_id')::uuid, chr(1) || p_emote) returning id into v_id;
  perform card_game.notify('card_chat:' || p_match_id || ':' || (v_who->>'channel'));
  return jsonb_build_object('id', v_id);
end $$;
