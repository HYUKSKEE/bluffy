/**
 * 카드 대결 규칙 (2~5인) — 순수 함수 모음.
 *
 * 서버(Postgres 함수, supabase/migrations/0002_game_engine.sql)가 실제 판정을 하며,
 * 이 파일은 (1) 규칙의 기준 구현/테스트, (2) 클라이언트의 버튼 활성화 계산에 쓰인다.
 * 두 구현은 tests(src/db/engine.test.ts)에서 서로 교차 검증된다.
 *
 * 좌석 인덱스는 0부터(DB 의 seat 은 1부터).
 */

export const START_CHIPS = 100
export const MAX_HANDS = 10
export const MIN_PLAYERS = 2
export const MAX_PLAYERS = 5
/** 기본 판돈(앤티): 매 판 1칩 */
export const ANTE = 1
export const MAX_RAISES = 3
export const MAX_RAISE_AMOUNT = 3
export const TURN_SECONDS = 20
export const IDLE_FORFEIT_SECONDS = 60

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

/** 일반: 1~10 카드 두 벌(20장). 섯다: 화투 카드 id 1~20 (20장). */
export function buildDeck(rules: RuleSet = 'standard'): number[] {
  const d: number[] = []
  for (let i = 0; i < 20; i++) d.push(rules === 'seotda' ? i + 1 : (i % 10) + 1)
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

/** n명에게 2장씩 배분 (덱 앞에서부터) */
export function deal(deck: readonly number[], n: number): { cards: Cards[]; rest: number[] } {
  if (deck.length < n * 2) throw new Error('덱이 부족합니다')
  const cards: Cards[] = []
  for (let i = 0; i < n; i++) cards.push([deck[2 * i], deck[2 * i + 1]])
  return { cards, rest: deck.slice(n * 2) }
}

// ───────────────────────── 섯다 룰 (화투 20장) ─────────────────────────
/**
 * 섯다: 화투 1~10월 두 장씩 20장. 카드 id 는 1~20 이며 월 = ceil(id / 2).
 *   1월: 1=광 2=띠   2월: 3=열끗 4=띠   3월: 5=광 6=띠   4월: 7=열끗 8=띠   5월: 9=열끗 10=띠
 *   6월: 11=열끗 12=띠   7월: 13=열끗 14=띠   8월: 15=광 16=열끗   9월: 17=열끗 18=띠   10월: 19=열끗 20=띠
 * 족보(높은 순): 38광땡 > 18광땡 = 13광땡 > 장땡 > 9땡 … 1땡 > 알리 > 독사 > 구삥 > 장삥 > 장사 > 세륙 > 갑오(9끗) … 망통(0끗).
 * 특수: 암행어사(4월 열끗 + 7월 열끗)는 18/13 광땡을 이기고(38광땡은 못 이김), 땡잡이(3월 광 + 7월 열끗)는
 *       1~9땡을 이긴다(장땡·광땡은 못 이김). 이 둘은 상대 패에 해당 족보가 있을 때만 힘을 쓰고 아니면 일반 끗이다.
 * (구사 재경기는 두지 않는다: 4+9 는 일반 3끗.)
 */
export type RuleSet = 'standard' | 'seotda'

export const SEOTDA_CARDS = 20
export const seotdaMonth = (id: number): number => Math.ceil(id / 2)

/** 월 쌍의 특수 족보 (낮은 월, 높은 월) → 점수 */
const SEOTDA_SPECIAL_MONTHS: Record<string, { name: string; rank: number }> = {
  '1,2': { name: '알리', rank: 8000 },
  '1,4': { name: '독사', rank: 7900 },
  '1,9': { name: '구삥', rank: 7800 },
  '1,10': { name: '장삥', rank: 7700 },
  '4,10': { name: '장사', rank: 7600 },
  '4,6': { name: '세륙', rank: 7500 },
}

/** 조건 없이 정해지는 기본 점수 (높을수록 강함). 같은 점수는 무승부. */
export function seotdaRank(cards: Cards): number {
  const [a, b] = cards
  const ma = seotdaMonth(a)
  const mb = seotdaMonth(b)
  if (ma === mb) return 9000 + ma * 10 // 땡 (장땡 = 9100)
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  if (lo === 5 && hi === 15) return 13000 // 38광땡
  if ((lo === 1 && hi === 15) || (lo === 1 && hi === 5)) return 12000 // 18광땡 / 13광땡
  const sp = SEOTDA_SPECIAL_MONTHS[`${Math.min(ma, mb)},${Math.max(ma, mb)}`]
  if (sp) return sp.rank
  return 5000 + ((ma + mb) % 10) // 끗
}

/** 상대 패에 따라 힘이 생기는 특수 족보 */
export function seotdaSpecial(cards: Cards): 'amhaeng' | 'ttaengjabi' | null {
  const lo = Math.min(cards[0], cards[1])
  const hi = Math.max(cards[0], cards[1])
  if (lo === 7 && hi === 13) return 'amhaeng' // 4월 열끗 + 7월 열끗
  if (lo === 5 && hi === 13) return 'ttaengjabi' // 3월 광 + 7월 열끗
  return null
}

/**
 * 한 팟(사이드 팟 단계)에 남은 사람들끼리의 점수: 특수 족보는 상대 패에 따라 올라간다.
 * - 암행어사: 이 팟에 18/13광땡이 있으면 12500(38광땡 13000 바로 아래)
 * - 땡잡이: 이 팟에 1~9땡이 있으면 9095(장땡 9100 바로 아래)
 */
export function seotdaShowdownRanks(hands: readonly Cards[]): number[] {
  const base = hands.map(seotdaRank)
  const hasGwang = base.some((r) => r === 12000)
  const hasTtaeng = base.some((r) => r >= 9010 && r <= 9090)
  return hands.map((h, i) => {
    const sp = seotdaSpecial(h)
    if (sp === 'amhaeng' && hasGwang) return 12500
    if (sp === 'ttaengjabi' && hasTtaeng) return 9095
    return base[i]
  })
}

/** 화면 표시용 족보 이름 */
export function handName(cards: Cards, rules: RuleSet = 'standard'): string {
  if (rules === 'standard') {
    const e = evaluate(cards)
    return e.category === 'pair' ? `${e.value} 페어` : `합 ${e.value}`
  }
  const sp = seotdaSpecial(cards)
  if (sp === 'amhaeng') return '암행어사'
  if (sp === 'ttaengjabi') return '땡잡이'
  const r = seotdaRank(cards)
  if (r === 13000) return '38광땡'
  if (r === 12000) return Math.min(cards[0], cards[1]) === 1 && Math.max(cards[0], cards[1]) === 15 ? '18광땡' : '13광땡'
  if (r >= 9010 && r <= 9100) return r === 9100 ? '장땡' : `${(r - 9000) / 10}땡`
  const ma = seotdaMonth(cards[0])
  const mb = seotdaMonth(cards[1])
  const sp2 = SEOTDA_SPECIAL_MONTHS[`${Math.min(ma, mb)},${Math.max(ma, mb)}`]
  if (sp2) return sp2.name
  const k = r - 5000
  return k === 9 ? '갑오' : k === 0 ? '망통' : `${k}끗`
}

/** 컴퓨터용: 족보를 0~1 로 환산한 "강함" */
export function handStrength(cards: Cards, rules: RuleSet = 'standard'): number {
  if (rules === 'standard') {
    const e = evaluate(cards)
    return e.category === 'pair' ? 0.72 + (e.value / 10) * 0.28 : 0.05 + ((e.value - 3) / 16) * 0.6
  }
  const r = seotdaRank(cards)
  if (r >= 12000) return 1
  if (r >= 9000) return 0.8 + ((r - 9000) / 100) * 0.18 // 땡
  if (r >= 7500) return 0.62 + ((r - 7500) / 500) * 0.12 // 알리 … 세륙
  return 0.05 + ((r - 5000) / 9) * 0.5 // 끗
}

// ───────────────────────── 판 상태 ─────────────────────────

export interface SeatState {
  /** 손에 남은 칩 (이번 판에 이미 건 칩 제외) */
  chips: number
  /** 이번 판에 건 칩 (기본 판돈 포함) */
  committed: number
  /** 이번 판에 카드를 받았는가 (칩이 없어 탈락한 사람은 false) */
  inHand: boolean
  folded: boolean
  /** 아직 행동해야 하는가 */
  pending: boolean
}

export interface HandState {
  seats: SeatState[]
  /** 이전 판에서 이월된 칩 */
  carryIn: number
  /** 이번 판에서 가장 많이 건 사람의 누적 금액 */
  level: number
  /** 베팅/레이즈 횟수 (최대 3) */
  raiseCount: number
  /** 지금 행동할 좌석. 베팅 없이 끝나는 판은 null */
  turn: number | null
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

export type HandEnd = { type: 'showdown' } | { type: 'fold'; winner: number }

export type ApplyResult =
  | { ok: true; state: HandState; end: HandEnd | null }
  | { ok: false; error: ActionError }

export const potOf = (s: HandState): number => s.carryIn + s.seats.reduce((a, x) => a + x.committed, 0)

export const toCall = (s: HandState, i: number): number => s.level - s.seats[i].committed

const isAlive = (x: SeatState) => x.inHand && !x.folded

/** from 다음(inclusive 면 포함) 좌석부터 시계방향으로 pending 인 첫 좌석 */
function nextPending(seats: readonly SeatState[], from: number, inclusive: boolean): number | null {
  const n = seats.length
  for (let k = inclusive ? 0 : 1; k <= n; k++) {
    const i = (from + k) % n
    if (seats[i].pending) return i
  }
  return null
}

/** 모든 행동 뒤의 판 종료/다음 차례 판정 */
function resolve(seats: SeatState[], from: number, inclusive: boolean): { turn: number | null; end: HandEnd | null } {
  const alive = seats.map((x, i) => (isAlive(x) ? i : -1)).filter((i) => i >= 0)
  if (alive.length === 1) return { turn: null, end: { type: 'fold', winner: alive[0] } }
  if (!seats.some((x) => x.pending)) return { turn: null, end: { type: 'showdown' } }
  return { turn: nextPending(seats, from, inclusive), end: null }
}

/**
 * 판 시작: 칩이 있는 사람이 앤티 1칩을 내고 선부터 행동.
 * 앤티를 내고도 칩이 남은 사람이 1명 이하면 베팅 없이 곧바로 쇼다운.
 */
export function startHand(chips: readonly number[], carry: number, lead: number): { state: HandState; end: HandEnd | null } {
  const ante = ANTE
  const seats: SeatState[] = chips.map((c) => {
    if (c <= 0) return { chips: 0, committed: 0, inHand: false, folded: false, pending: false }
    const pay = Math.min(c, ante)
    return { chips: c - pay, committed: pay, inHand: true, folded: false, pending: c - pay > 0 }
  })
  if (seats.filter((x) => x.pending).length <= 1) seats.forEach((x) => (x.pending = false))
  const level = Math.max(0, ...seats.map((x) => x.committed))
  const { turn, end } = resolve(seats, lead, true)
  return { state: { seats, carryIn: carry, level, raiseCount: 0, turn }, end }
}

/** 선: 판마다 한 칸씩 이동 (칩이 남은 사람 기준). handNo 는 1부터. */
export function leadSeat(handNo: number, chips: readonly number[]): number {
  const alive = chips.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0)
  return alive[(handNo - 1) % alive.length]
}

/** 지금 행동할 수 있는 행동 목록 (버튼 활성화용) */
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

export function legalFor(p: { chips: number; committed: number; level: number; raiseCount: number }): LegalActions {
  const need = p.level - p.committed
  const rm = p.raiseCount >= MAX_RAISES ? 0 : Math.max(0, Math.min(MAX_RAISE_AMOUNT, p.chips - need))
  return {
    canCheck: need === 0,
    canCall: need > 0,
    callAmount: Math.min(need, p.chips),
    canRaise: rm >= 1,
    raiseKind: need === 0 ? 'bet' : 'raise',
    raiseMax: rm,
    canDie: true,
  }
}

export function legalActions(s: HandState, i: number): LegalActions {
  return legalFor({ chips: s.seats[i].chips, committed: s.seats[i].committed, level: s.level, raiseCount: s.raiseCount })
}

export function applyAction(s: HandState, seat: number, a: Action): ApplyResult {
  if (s.turn !== seat) return { ok: false, error: 'NOT_YOUR_TURN' }
  const me = s.seats[seat]
  const need = toCall(s, seat)
  const seats: SeatState[] = s.seats.map((x) => ({ ...x }))
  const mine = seats[seat]
  let level = s.level
  let raiseCount = s.raiseCount
  let raised = false

  switch (a.type) {
    case 'check':
      if (need !== 0) return { ok: false, error: 'CANNOT_CHECK' }
      break
    case 'bet':
    case 'raise': {
      if ((a.type === 'bet') !== (need === 0)) return { ok: false, error: 'WRONG_ACTION' }
      if (raiseCount >= MAX_RAISES) return { ok: false, error: 'RAISE_LIMIT' }
      const mx = Math.min(MAX_RAISE_AMOUNT, me.chips - need)
      if (!Number.isInteger(a.amount) || a.amount < 1 || a.amount > mx) return { ok: false, error: 'BAD_AMOUNT' }
      const pay = need + a.amount
      mine.chips -= pay
      mine.committed += pay
      level += a.amount
      raiseCount += 1
      raised = true
      break
    }
    case 'call': {
      if (need <= 0) return { ok: false, error: 'NOTHING_TO_CALL' }
      const pay = Math.min(need, me.chips) // 칩이 모자라면 남은 칩 전부로 콜(올인)
      mine.chips -= pay
      mine.committed += pay
      break
    }
    case 'die':
      mine.folded = true
      break
  }
  mine.pending = false
  if (raised) {
    seats.forEach((x, i) => {
      if (i !== seat && isAlive(x) && x.chips > 0) x.pending = true // 레이즈 후 모두 다시 행동
    })
  }
  const { turn, end } = resolve(seats, seat, false)
  return { ok: true, state: { seats, carryIn: s.carryIn, level, raiseCount, turn }, end }
}

/** 시간 초과 시 자동 행동: 체크 가능하면 체크, 아니면 다이 */
export function timeoutAction(s: HandState, i: number): Action {
  return toCall(s, i) === 0 ? { type: 'check' } : { type: 'die' }
}

/** 나가기/무응답으로 기권: 현재 판에서 다이 처리 */
export function forfeitSeat(s: HandState, seat: number): { state: HandState; end: HandEnd | null } {
  const seats = s.seats.map((x) => ({ ...x }))
  seats[seat].folded = true
  seats[seat].pending = false
  const { turn, end } = resolve(seats, seat, false)
  return { state: { ...s, seats, turn }, end }
}

// ───────────────────────── 정산 ─────────────────────────

export interface Settlement {
  /** 좌석별 획득 칩 */
  payouts: number[]
  /** 다음 판으로 이월되는 칩 (동점 분배 후 남는 칩) */
  carry: number
}

/** 다이로 끝남: 남은 한 명이 판돈 전부 */
export function settleFold(s: HandState, winner: number): Settlement {
  const payouts = s.seats.map(() => 0)
  payouts[winner] = potOf(s)
  return { payouts, carry: 0 }
}

/**
 * 쇼다운: 건 금액 단계별(사이드 팟)로 생존자 중 가장 높은 족보가 가져간다.
 * 동점이면 나누고 남는 칩은 다음 판으로 이월. hands[i] 는 생존자의 카드.
 */
export function settleShowdown(s: HandState, hands: readonly (Cards | null)[], rules: RuleSet = 'standard'): Settlement {
  const payouts = s.seats.map(() => 0)
  const levels = [...new Set(s.seats.map((x) => x.committed).filter((c) => c > 0))].sort((a, b) => a - b)
  let prev = 0
  let roll = 0
  let carry = 0
  let first = true
  for (const lv of levels) {
    const contributors = s.seats.filter((x) => x.committed >= lv).length
    let amount = (lv - prev) * contributors + roll
    roll = 0
    if (first) {
      amount += s.carryIn
      first = false
    }
    prev = lv
    const eligible = s.seats.map((x, i) => (isAlive(x) && x.committed >= lv ? i : -1)).filter((i) => i >= 0)
    if (eligible.length === 0) {
      roll = amount
      continue
    }
    let winners = [eligible[0]]
    if (rules === 'seotda') {
      // 특수 족보(암행어사·땡잡이)는 이 팟에 남은 사람들의 패에 따라 힘이 정해진다
      const ranks = seotdaShowdownRanks(eligible.map((i) => hands[i]!))
      const best = Math.max(...ranks)
      winners = eligible.filter((_, k) => ranks[k] === best)
    } else {
      for (const i of eligible.slice(1)) {
        const c = compareHands(hands[i]!, hands[winners[0]]!)
        if (c > 0) winners = [i]
        else if (c === 0) winners.push(i)
      }
    }
    const each = Math.floor(amount / winners.length)
    carry += amount % winners.length
    winners.forEach((w) => (payouts[w] += each))
  }
  return { payouts, carry: carry + roll }
}

// ───────────────────────── 매치 ─────────────────────────

export interface MatchSeat {
  chips: number
  left: boolean
}

/** 한 판이 끝난 뒤 매치 종료 여부. handNo 는 방금 끝난 판 번호(1부터). */
export function matchOutcome(seats: readonly MatchSeat[], handNo: number): { finished: boolean; reason: 'bust' | 'forfeit' | 'complete' | null } {
  const remaining = seats.filter((x) => !x.left && x.chips > 0).length
  if (remaining <= 1) return { finished: true, reason: seats.some((x) => x.left) ? 'forfeit' : 'bust' }
  if (handNo >= MAX_HANDS) return { finished: true, reason: 'complete' }
  return { finished: false, reason: null }
}

/** 승자: 나가지 않은 사람 중 칩이 가장 많은 사람(동점이면 공동 승자) */
export function matchWinners(seats: readonly MatchSeat[]): boolean[] {
  const stay = seats.filter((x) => !x.left)
  if (stay.length === 0) return seats.map(() => false)
  const max = Math.max(...stay.map((x) => x.chips))
  return seats.map((x) => !x.left && x.chips === max)
}

/** 매치 수익. 기권자는 이득을 챙길 수 없다(수익 상한 0). */
export function matchProfit(finalChips: number, left = false, startChips = START_CHIPS): number {
  const p = finalChips - startChips
  return left ? Math.min(p, 0) : p
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
