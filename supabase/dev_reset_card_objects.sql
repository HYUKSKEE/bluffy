-- ⚠️ 개발용 수동 스크립트 (마이그레이션 아님 — supabase/migrations 에 두지 않았습니다)
--
-- 이 게임이 만든 `card_` 객체"만" 이름을 하나하나 지정해 삭제합니다.
-- 같은 Supabase 프로젝트의 다른 게임(가위바위보)의 테이블/함수/스키마는 건드리지 않습니다.
--
-- 언제 쓰나: 예전(1:1 버전) 마이그레이션을 이미 실행했는데 새 버전(2~5인)으로 바꾸고 싶을 때.
--           (새 마이그레이션은 기존 객체를 덮어쓰지 않으므로, 같은 이름이 있으면 오류로 멈춥니다.)
-- 주의: card_ 테이블의 데이터(방, 참가자, 랭킹)가 모두 사라집니다. 이 스크립트를 실행한 뒤
--       0001 → 0002 → 0003 마이그레이션을 다시 실행하세요.

-- 공개 RPC (현재 + 이전 버전에 있던 시그니처)
drop function if exists public.card_create_room(text, text);
drop function if exists public.card_get_room_view(uuid);
drop function if exists public.card_join_room(uuid, text);
drop function if exists public.card_my_status(uuid);
drop function if exists public.card_heartbeat(uuid);
drop function if exists public.card_queue_match(uuid);
drop function if exists public.card_cancel_queue(uuid);          -- 1:1 버전에만 있었음
drop function if exists public.card_start_match(uuid);
drop function if exists public.card_leave_match(uuid);
drop function if exists public.card_get_visible_hand(uuid, int);
drop function if exists public.card_get_match_state(uuid);
drop function if exists public.card_act(uuid, text, int);
drop function if exists public.card_timeout_check(uuid);
drop function if exists public.card_advance_match(uuid);
drop function if exists public.card_verify_admin(uuid, text);
drop function if exists public.card_close_room(uuid, text);

-- 테이블 (card_ 접두어만, 외래키 순서와 무관하게 한 번에)
drop table if exists
  public.card_actions,
  public.card_hand_seats,
  public.card_hands,
  public.card_match_players,
  public.card_matches,
  public.card_players,
  public.card_rooms;

-- 내부 함수 스키마 (이 게임 전용)
drop schema if exists card_game cascade;
