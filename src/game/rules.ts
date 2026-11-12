/**
 * 카드 대결 규칙 — 순수 함수 모음.
 *
 * 서버(Postgres 함수, supabase/migrations/0002_game_engine.sql)가 실제 판정을 하며,
 * 이 파일은 (1) 규칙의 기준 구현/테스트, (2) 클라이언트의 버튼 활성화 계산에 쓰인다.
 * 두 구현은 tests(src/db/engine.test.ts)에서 서로 교차 검증된다.
 */

export const START_CHIPS = 20
export const MAX_HANDS = 5
export const ANTE = 1
export const MAX_RAISES = 3
export const MAX_RAISE_AMOUNT = 3
export const TURN_SECONDS = 20
export const IDLE_FORFEIT_SECONDS = 60

export type Seat = 0 | 1
export type Cards = readonly [number, number]

export interface HandValue {
  category: 'pair' | 'sum'
  value: number
}

/** 족보: 페어 > 합. 페어끼리는 숫자, 합끼리는 합계. */
export function evaluate(cards: Cards): HandValue {
  const [a, b] = cards
  return a === b ? { category: 'pair', value: a } : { category: 'sum', value: a + b }
}

/** 1: a 승, -1: b 승, 0: 무승부 */
export function compareHands(a: Cards, b: Cards): 1 | -1 | 0 {
  const ea = evaluate(a)
  const eb = evaluate(b)
  if (ea.category !== eb.category) return ea.category === 'pair' ? 1 : -1
  if (ea.value === eb.value) return 0
  return ea.value > eb.value ? 1 : -1
}

/** 1~10 두 벌 (20장) */
export function buildDeck(): number[] {
  const d: number[] = []
  for (let i = 0; i < 20; i++) d.push((i % 10) + 1)
  return d
}

/** Fisher–Yates. rng 는 [0,1) 를 돌려주는 함수 */
export function shuffle<T>(arr: readonly T[], rng: () => number = Math.random): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export function deal(deck: readonly number[]): { cards: [Cards, Cards]; rest: number[] } {
  if (deck.length < 4) throw new Error('덱이 부족합니다')
  return { cards: [[deck[0], deck[1]], [deck[2], deck[3]]], rest: deck.slice(4) }
}

/** 판돈 분배. winner: 0|1 = 승자 좌석, 'tie' = 무승부(반씩, 홀수 칩은 이월) */
export function splitPot(pot: number, winner: Seat | 'tie'): { payout: [number, number]; carry: number } {
  if (winner === 'tie') {
    const half = Math.floor(pot / 2)
    return { payout: [half, half], carry: pot % 2 }
  }
  return { payout: winner === 0 ? [pot, 0] : [0, pot], carry: 0 }
}

// ───────────────────────── 베팅 ─────────────────────────

export interface BettingState {
  /** 각자 손에 남은 칩 (이번 판에 이미 건 칩 제외) */
  stacks: [number, number]
  /** 이번 판에 각자 건 칩 (기본 판돈 포함) */
  committed: [number, number]
  /** 판돈 전체 (이월분 포함) */
  pot: number
  /** 지금 행동할 좌석 */
  turn: Seat
  /** 이번 판에서 나온 베팅/레이즈 횟수 (최대 3) */
  raiseCount: number
  /** 마지막 베팅 이후 연속 체크 수 */
  checks: number
}

export type Action =
  | { type: 'check' }
  | { type: 'bet'; amount: number }
  | { type: 'raise'; amount: number }
  | { type: 'call' }
  | { type: 'die' }

export type ActionError =
  | 'CANNOT_CHECK'
  | 'NOTHING_TO_CALL'
  | 'WRONG_ACTION'
  | 'RAISE_LIMIT'
  | 'BAD_AMOUNT'
  | 'NOT_YOUR_TURN'

export type HandEnd = { type: 'showdown' } | { type: 'fold'; loser: Seat }

export type ApplyResult =
  | { ok: true; state: BettingState; end: HandEnd | null }
  | { ok: false; error: ActionError }

const other = (s: Seat): Seat => (s === 0 ? 1 : 0)

/** 판 시작: 기본 판돈 1칩씩. carry 는 이월된 홀수 칩. 한쪽 칩이 0이 되면 베팅 없이 곧바로 쇼다운. */
export function startHand(
  stacks: readonly [number, number],
  carry: number,
  lead: Seat,
): { state: BettingState; immediateShowdown: boolean } {
  const s: [number, number] = [stacks[0] - ANTE, stacks[1] - ANTE]
  if (s[0] < 0 || s[1] < 0) throw new Error('기본 판돈을 낼 칩이 없습니다')
  return {
    state: { stacks: s, committed: [ANTE, ANTE], pot: carry + 2 * ANTE, turn: lead, raiseCount: 0, checks: 0 },
    immediateShowdown: s[0] === 0 || s[1] === 0,
  }
}

/** 지금 행동자가 맞춰야 할 칩 */
export function toCall(s: BettingState): number {
  return s.committed[other(s.turn)] - s.committed[s.turn]
}

/**
 * 베팅/레이즈 가능한 최대 금액(없으면 0).
 * 내 칩(콜 금액 제외)과 상대 칩을 넘을 수 없다 → 상대가 항상 콜할 수 있다.
 */
export function maxRaise(s: BettingState): number {
  if (s.raiseCount >= MAX_RAISES) return 0
  const mine = s.stacks[s.turn] - toCall(s)
  const theirs = s.stacks[other(s.turn)]
  return Math.max(0, Math.min(MAX_RAISE_AMOUNT, mine, theirs))
}

export interface LegalActions {
  canCheck: boolean
  canCall: boolean
  callAmount: number
  canRaise: boolean
  /** 'bet' (올린 금액이 없을 때) 또는 'raise' */
  raiseKind: 'bet' | 'raise'
  raiseMax: number
  canDie: boolean
}

export function legalActions(s: BettingState): LegalActions {
  const need = toCall(s)
  const rm = maxRaise(s)
  return {
    canCheck: need === 0,
    canCall: need > 0,
    callAmount: Math.min(need, s.stacks[s.turn]),
    canRaise: rm >= 1,
    raiseKind: need === 0 ? 'bet' : 'raise',
    raiseMax: rm,
    canDie: true,
  }
}

export function applyAction(s: BettingState, seat: Seat, a: Action): ApplyResult {
  if (seat !== s.turn) return { ok: false, error: 'NOT_YOUR_TURN' }
  const opp = other(seat)
  const need = toCall(s)
  const stacks: [number, number] = [s.stacks[0], s.stacks[1]]
  const committed: [number, number] = [s.committed[0], s.committed[1]]
  let pot = s.pot
  let raiseCount = s.raiseCount
  let checks = s.checks
  let end: HandEnd | null = null

  switch (a.type) {
    case 'check': {
      if (need !== 0) return { ok: false, error: 'CANNOT_CHECK' }
      checks += 1
      if (checks >= 2) end = { type: 'showdown' }
      break
    }
    case 'bet':
    case 'raise': {
      if ((a.type === 'bet') !== (need === 0)) return { ok: false, error: 'WRONG_ACTION' }
      if (raiseCount >= MAX_RAISES) return { ok: false, error: 'RAISE_LIMIT' }
      if (!Number.isInteger(a.amount) || a.amount < 1 || a.amount > maxRaise(s)) return { ok: false, error: 'BAD_AMOUNT' }
      const pay = need + a.amount
      stacks[seat] -= pay
      committed[seat] += pay
      pot += pay
      raiseCount += 1
      checks = 0
      break
    }
    case 'call': {
      if (need <= 0) return { ok: false, error: 'NOTHING_TO_CALL' }
      const pay = Math.min(need, stacks[seat])
      const refund = need - pay // 칩이 모자라 올인 콜이면 상대의 초과분은 돌려준다
      stacks[seat] -= pay
      committed[seat] += pay
      pot += pay
      if (refund > 0) {
        committed[opp] -= refund
        stacks[opp] += refund
        pot -= refund
      }
      end = { type: 'showdown' }
      break
    }
    case 'die': {
      end = { type: 'fold', loser: seat }
      break
    }
  }
  return { ok: true, state: { stacks, committed, pot, turn: opp, raiseCount, checks }, end }
}

/** 시간 초과 시 자동 행동: 체크 가능하면 체크, 아니면 다이 */
export function timeoutAction(s: BettingState): Action {
  return toCall(s) === 0 ? { type: 'check' } : { type: 'die' }
}

// ───────────────────────── 판/매치 결산 ─────────────────────────

export interface SettleResult {
  stacks: [number, number]
  carry: number
}

/** winner: 좌석 또는 'tie'. 판돈을 칩에 반영한다. */
export function settleHand(stacks: readonly [number, number], pot: number, winner: Seat | 'tie'): SettleResult {
  const { payout, carry } = splitPot(pot, winner)
  return { stacks: [stacks[0] + payout[0], stacks[1] + payout[1]], carry }
}

export interface MatchOutcome {
  finished: boolean
  reason: 'bust' | 'complete' | null
  /** 매치 승자 좌석. 무승부/미종료는 null */
  winner: Seat | null
}

/** 한 판이 끝난 뒤 매치 종료 여부. handNo 는 방금 끝난 판 번호(1부터). */
export function matchOutcome(stacks: readonly [number, number], handNo: number): MatchOutcome {
  const bust = stacks[0] === 0 || stacks[1] === 0
  if (!bust && handNo < MAX_HANDS) return { finished: false, reason: null, winner: null }
  const winner: Seat | null = stacks[0] > stacks[1] ? 0 : stacks[1] > stacks[0] ? 1 : null
  return { finished: true, reason: bust ? 'bust' : 'complete', winner }
}

/**
 * 매치 수익. 기권/시간초과로 나간 사람은 이득을 챙길 수 없다(수익 상한 0).
 */
export function matchProfit(finalChips: number, forfeited = false): number {
  const p = finalChips - START_CHIPS
  return forfeited ? Math.min(p, 0) : p
}

/** 선 플레이어: 홀수 판은 좌석 0(먼저 대기한 사람), 짝수 판은 좌석 1 */
export function leadSeat(handNo: number): Seat {
  return handNo % 2 === 1 ? 0 : 1
}

// ───────────────────────── 랭킹 ─────────────────────────

export interface RankRow {
  total_profit: number
  matches_won: number
  joined_at: string
}

/** 누적 수익 ↓ → 승리 매치 수 ↓ → 먼저 참여한 순 */
export function compareRank(a: RankRow, b: RankRow): number {
  if (a.total_profit !== b.total_profit) return b.total_profit - a.total_profit
  if (a.matches_won !== b.matches_won) return b.matches_won - a.matches_won
  return new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime()
}
