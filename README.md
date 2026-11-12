# 블러피 — 링크로 즐기는 1:1 카드 베팅 대결

방 생성자가 모드를 골라 방을 만들고 링크를 공유하면, 들어온 사람끼리 자동으로 1:1 매칭되어 가상 칩을 걸고 대결합니다. 방 안에서 누적 칩 수익으로 랭킹을 매깁니다.

> 칩은 **가상의 무료 포인트**입니다. 현금·경품·충전·환전·거래 기능은 없습니다.

- 프론트엔드: Vite + React + TypeScript, React Router, Tailwind CSS, React Three Fiber (3D 카드)
- 백엔드: **서버 코드 없음.** Supabase(Anonymous Auth, Postgres, RLS, Realtime Broadcast, RPC)만 사용. 무료 플랜으로 동작
- 배포: Vercel (SPA 리라이트 포함)

## 이 프로젝트의 DB 객체 이름 규칙 (다른 게임과 같은 Supabase 프로젝트 공유)

같은 프로젝트에서 다른 게임(가위바위보)과 함께 쓸 수 있도록 **이 게임이 만드는 모든 객체는 `card_` 접두어**를 가집니다.

| 종류 | 이름 |
| --- | --- |
| 테이블 | `card_rooms`, `card_players`, `card_matches`, `card_hands`, `card_actions` |
| RPC | `card_create_room`, `card_get_room_view`, `card_join_room`, `card_my_status`, `card_heartbeat`, `card_queue_match`, `card_cancel_queue`, `card_get_visible_hand`, `card_get_match_state`, `card_act`, `card_timeout_check`, `card_advance_match`, `card_leave_match`, `card_verify_admin`, `card_close_room` |
| 내부 스키마 | `card_game` (클라이언트 접근 불가) |
| 인덱스 | `card_*` |
| Realtime 토픽 | `card_room:<id>`, `card_match:<id>` |

마이그레이션은 **기존 객체를 DROP/ALTER/REPLACE 하지 않습니다.** `create table` / `create function`(`or replace` 없음) / `create schema`(`if not exists` 없음)만 쓰므로, 같은 이름이 이미 있으면 덮어쓰지 않고 오류로 멈춥니다. 권한 `revoke`/`grant` 도 이 게임의 객체에만 하나씩 지정합니다(스키마 전체 대상 구문 없음). 이 동작은 테스트(`src/db/coexist.test.ts`)로 검증합니다. 기존 `rooms`, `create_room`, `act`, `game` 스키마가 있는 DB에 적용해도 데이터·권한·구조가 그대로입니다.

## 시작하기

### 1. Supabase 설정
1. [supabase.com](https://supabase.com)에서 프로젝트를 만듭니다(무료 플랜 가능). 가위바위보와 같은 프로젝트를 써도 됩니다.
2. **Authentication → Sign In / Providers → Anonymous Sign-Ins** 를 **켭니다.** (꺼져 있으면 입장할 수 없습니다)
3. (권장) Authentication의 CAPTCHA/Rate limit 설정으로 익명 가입 남용을 막습니다.
4. Realtime 은 기본값(Broadcast 사용 가능) 그대로 두면 됩니다. 이 앱은 DB 변경 스트림을 쓰지 않고, DB가 보내는 "바뀌었다" 신호(Broadcast)만 받습니다. 신호가 끊겨도 3~5초 폴링으로 동작합니다.

### 2. SQL 실행
Supabase **SQL Editor**에서 아래 파일을 **순서대로** 실행합니다.

1. `supabase/migrations/0001_schema.sql` — 테이블, 제약, RLS, 권한
2. `supabase/migrations/0002_game_engine.sql` — 덱 섞기, 베팅 검증, 승패 판정, 칩 계산(내부 함수)
3. `supabase/migrations/0003_rpc.sql` — 클라이언트용 RPC 와 실행 권한

(Supabase CLI를 쓴다면 `supabase db push`.) 한 번만 실행하세요. 다시 실행하면 이미 있는 객체 때문에 오류로 멈추며, 기존 객체는 변경되지 않습니다.

### 3. 환경변수
```bash
cp .env.example .env
```
`.env` 에 **Project Settings → API** 의 값을 넣습니다.
```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=<anon public key>
```
**`service_role` 키는 절대 프론트엔드에 넣지 마세요.** 이 앱에는 필요 없습니다.

### 4. 로컬 실행
```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 규칙/DB 테스트
npm run build      # 타입체크 + 프로덕션 빌드
```
개발 서버에서는 `/demo` 로 Supabase 없이 3D 카드 연출(뒷면, 공개 표식, 이마 카드, 쇼다운 뒤집기)을 미리 볼 수 있습니다(프로덕션 빌드에는 포함되지 않음).

### 5. Vercel 배포
1. GitHub 에 푸시하고 Vercel 에서 저장소를 Import (Framework: Vite 자동 인식).
2. **Environment Variables** 에 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` 를 등록.
3. Deploy. `vercel.json` 의 리라이트가 `/r/:id` 같은 경로를 SPA 로 처리합니다.
4. OG 이미지(`public/og.svg`)는 일부 메신저가 SVG 를 지원하지 않습니다. 1200×630 PNG 로 교체하고 `index.html` 의 `og:image` 를 절대 URL(`https://내도메인/og.png`)로 바꾸면 링크 미리보기가 가장 안정적입니다.

## 화면

| 경로 | 설명 |
| --- | --- |
| `/` | 소개, 방 만들기, 30초 규칙 (첫 방문 시 자동 안내) |
| `/create` | 방 제목 + 모드(A/B 설명 카드) → 공유 링크·관리 링크 복사 |
| `/r/:id` | 닉네임 → 로비(실시간 랭킹, 대결 찾기) → 대결 화면. 새로고침/재접속하면 진행 중인 매치로 복귀 |
| `/r/:id/admin` | 참가자 수, 진행 중 매치 수, 랭킹, 방 종료(확인 모달). 관리 링크(`#t=토큰`)로 접속 |
| `/r/:id/result` | 최종 랭킹(1~3위 시상대), 내 순위 강조 |

연결 실패(네트워크 끊김, 무료 프로젝트 일시정지 등)는 친절한 에러 화면과 "다시 시도" 버튼으로 안내합니다.

## 게임 규칙

### 모드 (방 생성 시 선택, 방 안의 모든 대결에 동일)
- **A 모드(반공개)**: 각자 카드 2장 중 1장은 공개, 1장은 비공개. 나는 내 카드 2장 + 상대의 공개 카드 1장을 봅니다.
- **B 모드(눈치)**: 나는 상대 카드 2장을 보고, 내 카드는 보지 못합니다(내 카드는 "?" 뒷면으로 이마에 붙은 연출).
- 두 모드 모두 **쇼다운이면 양쪽 카드가 공개**되고, **다이로 끝나면 카드를 공개하지 않습니다.**

### 한 판
- 덱: 1~10 카드 두 벌(20장). 매 판 새로 섞어 각자 2장.
- 족보: **페어(같은 숫자 2장) > 합이 큰 쪽.** 페어끼리는 숫자가 큰 쪽 승리. 완전히 같으면 판돈을 나눕니다(홀수 칩은 다음 판 판돈으로 이월).
- 시작 시 둘 다 기본 판돈 1칩.
- 선 플레이어부터 번갈아 행동하며, 선은 판마다 교대합니다(첫 판 선 = 먼저 대기한 사람).
- 행동: **체크**(올린 금액이 없을 때만) / **베팅·레이즈**(1~3칩) / **콜**(맞추고 쇼다운) / **다이**(판돈 포기). 둘 다 체크하면 쇼다운.
- 한 판에 베팅/레이즈는 총 3회까지. 턴 제한 20초 — 초과 시 체크 가능하면 체크, 아니면 다이.

### 매치와 랭킹
- 각자 시작 칩 20개, 최대 5판. 한쪽 칩이 0이 되면 즉시 종료. 종료 시 칩이 더 많은 쪽이 승리(같으면 무승부).
- 매치 종료 시 **(최종 칩 − 20)** 이 방 누적 수익에 더해집니다. 다음 매치는 다시 20칩으로 시작.
- 랭킹: 누적 수익 ↓ → 승리 매치 수 ↓ → 먼저 참여한 순.
- 방 종료는 생성자만(관리 링크의 토큰, DB 에는 SHA-256 해시만 저장). 진행 중인 매치는 무효 처리(수익 미반영)되고 최종 순위가 확정됩니다.

### 규칙이 모호해서 임의로 정한 부분
1. **레이즈 횟수**: 첫 베팅도 1회로 셉니다(베팅/레이즈 합쳐 판당 최대 3회). 3회가 나오면 상대는 콜/다이만 가능.
2. **레이즈 금액**: "올림 금액"이 1~3칩이며, 레이즈는 상대가 올린 금액을 맞춘 뒤 그 위에 올립니다(콜 금액 + 올림 금액을 냄).
3. **베팅 상한**: 올림 금액은 `min(3, 내 칩 − 콜 금액, 상대 남은 칩)`. 그래서 상대는 항상 콜할 수 있고, 올인(내 남은 칩 전부 베팅) 이후 상대는 레이즈할 수 없습니다. 만일 칩이 모자라는 상황이 생기면 남은 칩 전부로 콜하고 상대의 초과분은 환급합니다.
4. **기본 판돈으로 칩이 0이 되면**(칩 1개만 남은 경우) 베팅 없이 곧바로 쇼다운합니다.
5. **무승부 이월**: 판돈이 홀수면 반씩 나누고 남는 1칩은 다음 판 판돈에 합칩니다. (이월 칩이 있는 매치가 마지막 판에서 끝나면 그 칩은 소멸)
6. **매치 승패**: 5판을 마쳤을 때 칩이 많은 쪽 승리, 같으면 무승부(승리 수 미반영, 수익 0). 칩이 0이 되면 상대 승리.
7. **무응답/나가기**: `나가기`는 기권. 상대가 **60초 넘게 응답이 없으면**(연결 유지 신호 중단) 남은 사람의 승리. 이때 진행 중이던 판돈은 남은 사람이 가져가고, **기권한 쪽은 이득을 챙길 수 없어** 수익은 `min(최종 칩 − 20, 0)` 입니다(앞서던 중 나가서 수익을 챙기는 것을 방지).
8. **연출 시간**: 판이 끝나면 다음 판 시작 전에 쇼다운 5초 / 다이 2초의 결과 연출 시간이 있습니다.
9. **A 모드의 공개 카드**: 매 판 서버가 각자 2장 중 어느 1장을 공개할지 무작위로 정합니다.
10. 닉네임은 방 안에서 대소문자 구분 없이 유일해야 하며 1~12자입니다. 한 방은 최대 200명.
11. 같은 브라우저(익명 계정)가 다시 들어오면 기존 참가자로 복귀합니다. 시크릿 창/다른 기기는 다른 참가자입니다.

## 보안 설계

핵심: **숨겨야 할 카드 값은 어떤 경로로도 브라우저에 전달되지 않습니다.**

- 덱 섞기·카드 배분·베팅 검증·승패 판정·칩 계산은 모두 Postgres `security definer` 함수에서만 합니다. 덱은 `gen_random_uuid()`(CSPRNG) 기준 정렬로 섞습니다.
- **클라이언트는 테이블에 직접 접근할 수 없습니다.** 5개 테이블 모두 RLS 를 켜고 정책을 만들지 않았으며, `anon`/`authenticated` 의 테이블 권한도 회수했습니다(이중 차단). 읽기·쓰기는 전부 RPC 로만 합니다. `card_hands` 의 `deck`, `cards1`, `cards2` 는 어떤 정책·권한으로도 SELECT 되지 않습니다.
- 카드는 `card_get_visible_hand(match_id)` 로만 조회하며, 모드와 요청자(`auth.uid()`)에 따라 볼 수 있는 카드만 돌려줍니다(못 보는 카드는 `null`).
  - A: 내 카드 2장 + 상대 공개 카드 1장 / B: 상대 카드 2장(내 카드 `null`) / 쇼다운 이후: 전부(다이로 끝난 판은 공개 안 함)
- `card_get_match_state` 등 카드 외 RPC 는 카드·덱 컬럼을 읽지 않고, 다른 사용자의 `uid` 도 노출하지 않습니다.
- Realtime 은 **Broadcast 신호**("changed")만 씁니다. 페이로드에는 시각만 있고 카드·칩 값이 없으며, 클라이언트는 신호를 받으면 RPC 로 다시 조회합니다. (DB 변경 스트림 `postgres_changes` 는 쓰지 않습니다.)
- 턴 순서, 금액, 레이즈 횟수, 20초 제한, 무응답 기권은 서버가 검증합니다. 클라이언트의 버튼 활성화는 같은 규칙을 계산한 편의 기능일 뿐이며, 서버가 규칙에 맞지 않는 요청은 예외로 거부합니다.
- 내부 함수는 `card_game` 스키마에 있고 클라이언트에 USAGE 권한이 없습니다. 공개 RPC 는 `anon` 과 `PUBLIC` 의 실행 권한을 회수하고 `authenticated`(익명 로그인 사용자 포함)에만 엽니다.
- 방 관리 토큰은 `card_create_room` 응답에서 한 번만 원문이 반환되고 DB 에는 SHA-256 해시만 저장됩니다. 토큰은 URL fragment(`#t=`)로 전달되어 서버로 전송되지 않으며, 접속 후 주소창에서 지워집니다.

한계: 익명 로그인이라 한 사람이 여러 브라우저 프로필로 여러 계정을 만들 수 있습니다(가상 칩·랭킹이므로 허용). 방 생성/입장에 대한 서버측 속도 제한은 없으니 필요하면 Supabase Auth 의 rate limit/CAPTCHA 를 켜세요.

## 테스트

```bash
npm test
```
| 파일 | 내용 |
| --- | --- |
| `src/game/rules.test.ts` | 족보 판정, 판돈 분배(무승부 이월 포함), 베팅 검증(차례·금액·레이즈 횟수·올인·시간 초과), 매치 종료/수익, 랭킹 정렬, 무작위 1000판 칩 보존 |
| `src/db/visibility.test.ts` | **모드별 `get_visible_hand` 가 숨긴 카드를 반환하지 않는지**(A/B, 쇼다운·다이 이후), 테이블 직접 접근 차단, 내부 함수/anon 차단, 응답에 카드·uid 없음, Realtime 신호에 값 없음 |
| `src/db/engine.test.ts` | 매칭, 서버측 베팅 검증, 무승부 이월, 타임아웃/기권, 방 종료, 랭킹. **TS 규칙 엔진과 SQL 엔진 교차 검증**(무작위 30매치) |
| `src/db/coexist.test.ts` | 기존 객체(다른 게임)와 공존: 이름 충돌 없음, 기존 데이터·권한·구조 불변 |

DB 테스트는 [PGlite](https://pglite.dev)(WASM Postgres)에 `supabase/migrations/*.sql` 을 그대로 적용해 실행하므로 로컬에 Postgres/Docker 가 필요 없습니다. Supabase 가 제공하는 `auth.uid()`, `anon`/`authenticated` 역할, 기본 권한, `realtime.send` 는 `src/db/harness.ts` 가 흉내 냅니다.

## 폴더 구조
```
supabase/migrations/   테이블·RLS·엔진·RPC (SQL)
src/game/rules.ts      족보·베팅 규칙 순수 함수 (테스트 기준 구현, 버튼 활성화에도 사용)
src/lib/               Supabase 클라이언트, RPC 래퍼, 훅(Realtime 신호 + 폴링)
src/components/        3D 카드 무대(MatchStage), UI 조각
src/pages/             Home, Create, Room(+로비), MatchScreen, Admin, Result, Demo
```
