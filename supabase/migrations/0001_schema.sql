-- 0001_schema.sql : 테이블, 제약, RLS, 권한
-- 원칙: 클라이언트(anon/authenticated)는 어떤 테이블도 직접 읽거나 쓸 수 없다.
--       모든 읽기/쓰기는 security definer RPC(0003_rpc.sql)로만 이루어진다.

-- 내부 함수용 스키마 (PostgREST 로 노출되지 않고, 클라이언트 권한도 없음)
create schema card_game;
revoke all on schema card_game from public;

-- ───────────── rooms ─────────────
create table public.card_rooms (
  id               uuid primary key default gen_random_uuid(),
  title            text not null check (char_length(title) between 1 and 40),
  mode             text not null check (mode in ('A', 'B')),
  status           text not null default 'open' check (status in ('open', 'closed')),
  admin_token_hash text not null,               -- sha256(admin_token). 원문은 저장하지 않는다.
  created_at       timestamptz not null default now(),
  closed_at        timestamptz
);

-- ───────────── players ─────────────
create table public.card_players (
  id              uuid primary key default gen_random_uuid(),
  room_id         uuid not null references public.card_rooms(id) on delete cascade,
  uid             uuid not null,                -- auth.uid() (익명 로그인 사용자)
  nickname        text not null check (char_length(nickname) between 1 and 12),
  joined_at       timestamptz not null default now(),
  total_profit    int not null default 0,
  matches_played  int not null default 0,
  matches_won     int not null default 0,
  status          text not null default 'idle' check (status in ('idle', 'queued', 'playing')),
  queued_at       timestamptz,
  last_seen       timestamptz not null default now(),
  final_rank      int,                          -- 방 종료 시 확정되는 최종 순위
  unique (room_id, uid)
);
create unique index card_players_room_nickname_uq on public.card_players (room_id, lower(nickname));
create index card_players_queue_idx on public.card_players (room_id, queued_at) where status = 'queued';

-- ───────────── matches ─────────────
create table public.card_matches (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.card_rooms(id) on delete cascade,
  player1_id   uuid not null references public.card_players(id),   -- 먼저 대기한 사람
  player2_id   uuid not null references public.card_players(id),
  chips1       int not null default 20 check (chips1 >= 0),   -- 판돈에 묶이지 않은 보유 칩
  chips2       int not null default 20 check (chips2 >= 0),
  hand_no      int not null default 0,
  status       text not null default 'playing' check (status in ('playing', 'finished', 'void')),
  winner_id    uuid references public.card_players(id),
  carry        int not null default 0,                         -- 무승부로 이월된 홀수 칩
  next_hand_at timestamptz,                                    -- 판 종료 후 다음 판을 시작할 수 있는 시각
  end_reason   text,                                           -- bust | complete | forfeit | void
  profit1      int,
  profit2      int,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  check (player1_id <> player2_id)
);
create index card_matches_room_status_idx on public.card_matches (room_id, status);

-- ───────────── hands ─────────────
create table public.card_hands (
  id             uuid primary key default gen_random_uuid(),
  match_id       uuid not null references public.card_matches(id) on delete cascade,
  hand_no        int not null,
  deck           int[] not null,                 -- 서버 전용 (클라이언트 SELECT 불가)
  cards1         int[] not null,                 -- 서버 전용
  cards2         int[] not null,                 -- 서버 전용
  open1          int not null check (open1 in (1, 2)),  -- A 모드에서 공개되는 카드의 인덱스
  open2          int not null check (open2 in (1, 2)),
  pot            int not null,
  current_bet    int not null default 0,         -- 마지막으로 올린 금액(상대가 콜해야 할 금액)
  committed1     int not null,                   -- 이번 판에 건 칩 (기본 판돈 포함)
  committed2     int not null,
  lead_player_id uuid not null references public.card_players(id),
  turn_player_id uuid references public.card_players(id),
  raise_count    int not null default 0,
  checks         int not null default 0,
  turn_deadline  timestamptz,
  status         text not null default 'betting' check (status in ('betting', 'finished', 'void')),
  revealed       boolean not null default false, -- 쇼다운으로 끝나 카드가 공개되었는가
  result         jsonb,
  created_at     timestamptz not null default now(),
  unique (match_id, hand_no)
);

-- ───────────── actions ─────────────
create table public.card_actions (
  id         bigint generated always as identity primary key,
  hand_id    uuid not null references public.card_hands(id) on delete cascade,
  player_id  uuid not null references public.card_players(id),
  action     text not null check (action in ('check', 'bet', 'raise', 'call', 'die')),
  amount     int not null default 0,
  auto       boolean not null default false,     -- 시간 초과 자동 행동
  created_at timestamptz not null default now()
);
create index card_actions_hand_idx on public.card_actions (hand_id, id);

-- ───────────── RLS + 권한 ─────────────
-- RLS 를 켜고 정책을 하나도 만들지 않는다 → 클라이언트 역할은 모든 행에 접근 불가.
-- (security definer 함수는 테이블 소유자 권한으로 실행되어 RLS 를 우회한다.)
alter table public.card_rooms   enable row level security;
alter table public.card_players enable row level security;
alter table public.card_matches enable row level security;
alter table public.card_hands   enable row level security;
alter table public.card_actions enable row level security;

-- Supabase 는 새 테이블에 anon/authenticated 권한을 기본 부여한다 → 이 마이그레이션이 만든 card_ 테이블만 회수.
-- (기존 객체(다른 게임의 테이블/함수/시퀀스)는 절대 건드리지 않는다. actions 의 identity 시퀀스는 테이블 권한을 따른다.)
-- 특히 hands(deck, cards1, cards2)는 어떤 권한/정책으로도 열리지 않는다.
revoke all on public.card_rooms, public.card_players, public.card_matches, public.card_hands, public.card_actions from public;
revoke all on public.card_rooms, public.card_players, public.card_matches, public.card_hands, public.card_actions from anon, authenticated;
