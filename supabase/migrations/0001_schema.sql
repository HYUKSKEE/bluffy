-- 0001_schema.sql : 테이블, 제약, RLS, 권한  (2~5인 테이블)
-- 이 게임이 만드는 모든 객체는 `card_` 접두어를 쓴다 (같은 Supabase 프로젝트의 다른 게임과 충돌 방지).
-- 기존 객체를 DROP/ALTER/REPLACE 하지 않는다. 같은 이름이 이미 있으면 덮어쓰지 않고 오류로 멈춘다.
--
-- 원칙: 클라이언트(anon/authenticated)는 어떤 테이블도 직접 읽거나 쓸 수 없다.
--       모든 읽기/쓰기는 security definer RPC(0003_rpc.sql)로만 이루어진다.

-- 내부 함수용 스키마 (PostgREST 로 노출되지 않고, 클라이언트 권한도 없음)
create schema card_game;
revoke all on schema card_game from public;

-- ───────────── card_rooms ─────────────
create table public.card_rooms (
  id               uuid primary key default gen_random_uuid(),
  title            text not null check (char_length(title) between 1 and 40),
  mode             text not null check (mode in ('A', 'B')),
  status           text not null default 'open' check (status in ('open', 'closed')),
  admin_token_hash text not null,               -- sha256(admin_token). 원문은 저장하지 않는다.
  created_at       timestamptz not null default now(),
  closed_at        timestamptz
);

-- ───────────── card_players (방 참가자 + 랭킹) ─────────────
create table public.card_players (
  id              uuid primary key default gen_random_uuid(),
  room_id         uuid not null references public.card_rooms(id) on delete cascade,
  uid             uuid not null,                -- auth.uid() (익명 로그인 사용자)
  nickname        text not null check (char_length(nickname) between 1 and 12),
  joined_at       timestamptz not null default now(),
  total_profit    int not null default 0,
  matches_played  int not null default 0,
  matches_won     int not null default 0,
  status          text not null default 'idle' check (status in ('idle', 'queued', 'playing')),  -- queued = 대기 테이블에 앉음
  queued_at       timestamptz,
  last_seen       timestamptz not null default now(),
  final_rank      int,                          -- 방 종료 시 확정되는 최종 순위
  unique (room_id, uid)
);
create unique index card_players_room_nickname_uq on public.card_players (room_id, lower(nickname));

-- ───────────── card_matches (테이블 1개 = 매치 1개, 2~5인) ─────────────
create table public.card_matches (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references public.card_rooms(id) on delete cascade,
  host_player_id uuid not null references public.card_players(id),   -- 방장: 대기 중에 마음대로 시작할 수 있다
  status         text not null default 'waiting' check (status in ('waiting', 'playing', 'finished', 'void')),
  start_chips    int not null default 100,
  max_hands      int not null default 10,
  hand_no        int not null default 0,
  carry          int not null default 0,                -- 무승부 나눗셈으로 남아 다음 판으로 이월된 칩
  next_hand_at   timestamptz,                           -- 판 종료 후 다음 판을 시작할 수 있는 시각
  end_reason     text,                                  -- bust | complete | forfeit | void
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz
);
create index card_matches_room_status_idx on public.card_matches (room_id, status);

-- ───────────── card_match_players (좌석 1~5) ─────────────
create table public.card_match_players (
  match_id   uuid not null references public.card_matches(id) on delete cascade,
  seat       int not null check (seat between 1 and 5),
  player_id  uuid not null references public.card_players(id),
  chips      int not null default 0 check (chips >= 0),   -- 판돈에 묶이지 않은 보유 칩
  left_match boolean not null default false,              -- 나가기/무응답으로 기권한 사람
  profit     int,                                         -- 매치 종료 시 확정
  is_winner  boolean not null default false,
  joined_at  timestamptz not null default now(),
  primary key (match_id, seat),
  unique (match_id, player_id)
);

-- ───────────── card_hands ─────────────
create table public.card_hands (
  id            uuid primary key default gen_random_uuid(),
  match_id      uuid not null references public.card_matches(id) on delete cascade,
  hand_no       int not null,
  deck          int[] not null,                  -- 서버 전용 (클라이언트 SELECT 불가)
  pot           int not null,                    -- 판돈 전체 (이월분 포함)
  carry_in      int not null default 0,          -- 이번 판에 합쳐진 이월 칩
  level         int not null default 1,          -- 이번 판에서 가장 많이 건 사람의 누적 금액
  current_bet   int not null default 0,          -- 마지막으로 올린 금액
  raise_count   int not null default 0,
  lead_seat     int not null,                    -- 선 (판마다 한 칸씩 이동)
  turn_seat     int,
  turn_deadline timestamptz,
  status        text not null default 'betting' check (status in ('betting', 'finished', 'void')),
  revealed      boolean not null default false,  -- 쇼다운으로 끝나 생존자의 카드가 공개되었는가
  result        jsonb,
  created_at    timestamptz not null default now(),
  unique (match_id, hand_no)
);

-- ───────────── card_hand_seats (판별 좌석 상태 + 카드) ─────────────
create table public.card_hand_seats (
  hand_id   uuid not null references public.card_hands(id) on delete cascade,
  seat      int not null,
  cards     int[] not null,                      -- 서버 전용 (클라이언트 SELECT 불가)
  open_idx  int not null check (open_idx in (1, 2)),   -- A 모드에서 공개되는 카드의 인덱스
  in_hand   boolean not null default true,
  committed int not null default 0,              -- 이번 판에 건 칩 (기본 판돈 포함)
  folded    boolean not null default false,
  pending   boolean not null default false,      -- 아직 행동해야 하는가 (마지막 레이즈 이후)
  primary key (hand_id, seat)
);

-- ───────────── card_actions ─────────────
create table public.card_actions (
  id         bigint generated always as identity primary key,
  hand_id    uuid not null references public.card_hands(id) on delete cascade,
  player_id  uuid not null references public.card_players(id),
  seat       int not null,
  action     text not null check (action in ('check', 'bet', 'raise', 'call', 'die')),
  amount     int not null default 0,
  auto       boolean not null default false,     -- 시간 초과/이탈 자동 행동
  created_at timestamptz not null default now()
);
create index card_actions_hand_idx on public.card_actions (hand_id, id);

-- ───────────── RLS + 권한 ─────────────
-- RLS 를 켜고 정책을 하나도 만들지 않는다 → 클라이언트 역할은 모든 행에 접근 불가.
-- (security definer 함수는 테이블 소유자 권한으로 실행되어 RLS 를 우회한다.)
alter table public.card_rooms         enable row level security;
alter table public.card_players       enable row level security;
alter table public.card_matches       enable row level security;
alter table public.card_match_players enable row level security;
alter table public.card_hands         enable row level security;
alter table public.card_hand_seats    enable row level security;
alter table public.card_actions       enable row level security;

-- Supabase 는 새 테이블에 anon/authenticated 권한을 기본 부여한다 → 이 마이그레이션이 만든 card_ 테이블만 회수.
-- (기존 객체(다른 게임의 테이블/함수/시퀀스)는 절대 건드리지 않는다. identity 시퀀스는 테이블 권한을 따른다.)
-- 특히 card_hands(deck)와 card_hand_seats(cards)는 어떤 권한/정책으로도 열리지 않는다.
revoke all on
  public.card_rooms, public.card_players, public.card_matches, public.card_match_players,
  public.card_hands, public.card_hand_seats, public.card_actions
from public;
revoke all on
  public.card_rooms, public.card_players, public.card_matches, public.card_match_players,
  public.card_hands, public.card_hand_seats, public.card_actions
from anon, authenticated;
