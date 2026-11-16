/**
 * 연습 게임(컴퓨터와 대결): 서버 없이 이 기기에서만 돌아가며 점수·랭킹에 반영되지 않는다.
 * 규칙 계산은 실제 게임과 같은 rules.ts 를 그대로 쓴다. 카드는 브라우저에 있어도 상관없다(걸린 것이 없으므로).
 * 0번 좌석 = 나, 나머지는 컴퓨터.
 */
import {
  applyAction, buildDeck, handStrength, leadSeat, legalActions, matchOutcome, matchWinners, potOf, settleFold, settleShowdown,
  shuffle, startHand, toCall, MAX_HANDS, START_CHIPS,
  type Action, type Cards, type HandEnd, type HandState, type LegalActions, type RuleSet,
} from './rules'

export type PracticeMode = 'A' | 'B'
export type Rng = () => number

export interface PracticeOpts {
  mode: PracticeMode
  /** 컴퓨터 수 (1~4) */
  bots: number
  /** 고난이도: 덱을 이어서 쓰는 카운팅 게임 */
  hard: boolean
  /** 섯다 룰(화투 20장·광땡/땡/특수 패/끗). 없으면 일반 룰 */
  rules?: RuleSet
}

/** 고난이도 공용 덱 (0 = 셔플 예고 카드). 서버(card_match_decks)와 같은 규칙. */
export interface PracticeDeck {
  sets: number
  deck: number[]
  shuffleNo: number
  fresh: boolean
  markerOut: boolean
}

export interface LogItem {
  id: number
  seat: number
  action: 'check' | 'bet' | 'raise' | 'call' | 'die'
  amount: number
}

export interface PracticeResult {
  reason: 'showdown' | 'fold'
  pot: number
  carry: number
  winners: { seat: number; amount: number }[]
}

export interface PracticeGame {
  opts: PracticeOpts
  names: string[]
  n: number
  /** 판 밖(칩 보유) — 판이 진행 중이면 hand.seats[i].chips 가 최신 */
  chips: number[]
  handNo: number
  carry: number
  hand: HandState | null
  cards: (Cards | null)[]
  /** A 모드에서 상대에게 공개되는 카드의 위치 (1|2) */
  openIdx: (1 | 2)[]
  status: 'betting' | 'finished' | 'over'
  result: PracticeResult | null
  log: LogItem[]
  logSeq: number
  deck: PracticeDeck | null
  overReason: 'bust' | 'complete' | null
}

const BOT_NAMES = ['미니', '코코', '루루', '푸푸']

export function newGame(opts: PracticeOpts, rng: Rng = Math.random): PracticeGame {
  const n = Math.min(5, Math.max(2, opts.bots + 1))
  const g: PracticeGame = {
    opts: { ...opts, bots: n - 1 },
    names: ['나', ...BOT_NAMES.slice(0, n - 1).map((x) => `🤖${x}`)],
    n,
    chips: Array(n).fill(START_CHIPS),
    handNo: 0,
    carry: 0,
    hand: null,
    cards: Array(n).fill(null),
    openIdx: Array(n).fill(1),
    status: 'betting',
    result: null,
    log: [],
    logSeq: 0,
    deck: null,
    overReason: null,
  }
  return startNextHand(g, rng)
}

/** 고난이도 덱 배분: 이어서 쓰고, 모자라거나 예고 카드가 나온 다음 판에 전부 모아 다시 섞는다. */
function dealHard(prev: PracticeDeck | null, players: number, rng: Rng, rules: RuleSet): { deck: PracticeDeck; dealt: number[] } {
  const per = rules === 'seotda' ? 20 : 10 // 한 벌의 장수
  const d: PracticeDeck = prev
    ? { ...prev, deck: prev.deck.slice() }
    : { sets: Math.ceil((players * 2 * 3) / per) * (per / 10), deck: [], shuffleNo: 0, fresh: true, markerOut: false }
  const real = d.deck.filter((x) => x !== 0).length
  if (!prev || d.markerOut || real < 2 * players) {
    const all = shuffle(Array.from({ length: d.sets * 10 }, (_, i) => (i % per) + 1), rng)
    const k = all.length - 2 * players // 아래에서 1라운드 분량 위치에 셔플 예고 카드
    d.deck = [...all.slice(0, k), 0, ...all.slice(k)]
    d.shuffleNo += 1
    d.fresh = true
  } else {
    d.fresh = false
  }
  d.markerOut = false
  const dealt: number[] = []
  while (dealt.length < 2 * players) {
    const c = d.deck.shift()!
    if (c === 0) d.markerOut = true
    else dealt.push(c)
  }
  return { deck: d, dealt }
}

/** 다음 판 시작 (진행 중인 판이 없을 때) */
export function startNextHand(g: PracticeGame, rng: Rng = Math.random): PracticeGame {
  const handNo = g.handNo + 1
  const lead = leadSeat(handNo, g.chips)
  const { state, end } = startHand(g.chips, g.carry, lead)
  const alive = g.chips.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0)
  let deck = g.deck
  let dealt: number[]
  if (g.opts.hard) {
    const r = dealHard(g.deck, alive.length, rng, g.opts.rules ?? 'standard')
    deck = r.deck
    dealt = r.dealt
  } else {
    dealt = shuffle(buildDeck(g.opts.rules ?? 'standard'), rng).slice(0, alive.length * 2)
  }
  const cards: (Cards | null)[] = Array(g.n).fill(null)
  const openIdx: (1 | 2)[] = Array(g.n).fill(1)
  alive.forEach((seat, k) => {
    cards[seat] = [dealt[2 * k], dealt[2 * k + 1]]
    openIdx[seat] = rng() < 0.5 ? 1 : 2
  })
  const next: PracticeGame = { ...g, handNo, hand: state, cards, openIdx, status: 'betting', result: null, log: [], deck }
  return end ? settle(next, end) : next
}

/** 판 정산 + 매치 종료 판정 */
function settle(g: PracticeGame, end: HandEnd): PracticeGame {
  const hand = g.hand!
  const s = end.type === 'fold' ? settleFold(hand, end.winner) : settleShowdown(hand, hand.seats.map((x, i) => (x.inHand && !x.folded ? g.cards[i] : null)), g.opts.rules ?? 'standard')
  const chips = hand.seats.map((x, i) => x.chips + s.payouts[i])
  const result: PracticeResult = {
    reason: end.type,
    pot: potOf(hand),
    carry: s.carry,
    winners: s.payouts.map((amount, seat) => ({ seat, amount })).filter((w) => w.amount > 0),
  }
  const out = matchOutcome(chips.map((c) => ({ chips: c, left: false })), g.handNo)
  return {
    ...g,
    chips,
    carry: s.carry,
    hand: { ...hand, turn: null },
    result,
    status: out.finished ? 'over' : 'finished',
    overReason: out.finished ? (out.reason === 'complete' ? 'complete' : 'bust') : null,
  }
}

/** 행동 적용 (순서가 아니거나 규칙에 어긋나면 null) */
export function act(g: PracticeGame, seat: number, a: Action): PracticeGame | null {
  if (g.status !== 'betting' || !g.hand) return null
  const r = applyAction(g.hand, seat, a)
  if (!r.ok) return null
  const item: LogItem = {
    id: g.logSeq + 1,
    seat,
    action: a.type,
    amount: a.type === 'bet' || a.type === 'raise' ? a.amount : a.type === 'call' ? Math.min(toCall(g.hand, seat), g.hand.seats[seat].chips) : 0,
  }
  const next: PracticeGame = { ...g, hand: r.state, log: [...g.log, item], logSeq: item.id }
  return r.end ? settle(next, r.end) : next
}

/** 판이 끝난 뒤 다음 판으로 (매치가 끝났으면 그대로) */
export function advance(g: PracticeGame, rng: Rng = Math.random): PracticeGame {
  return g.status === 'finished' ? startNextHand(g, rng) : g
}

export function standings(g: PracticeGame) {
  const win = matchWinners(g.chips.map((c) => ({ chips: c, left: false })))
  return g.chips.map((c, seat) => ({ seat, name: g.names[seat], chips: c, profit: c - START_CHIPS, isWinner: win[seat] })).sort((a, b) => b.chips - a.chips || a.seat - b.seat)
}

export function turnSeat(g: PracticeGame): number | null {
  return g.status === 'betting' && g.hand ? g.hand.turn : null
}

/** 화면용 덱 정보 (서버의 pile 과 같은 모양) */
export function pileInfo(g: PracticeGame) {
  if (!g.opts.hard || !g.deck) return { hard: false as const }
  const d = g.deck
  return {
    hard: true as const,
    sets: d.sets,
    total: d.sets * 10,
    remaining: d.deck.filter((x) => x !== 0).length,
    shuffle_no: d.shuffleNo,
    fresh: d.fresh,
    marker_out: d.markerOut,
  }
}

// ───────────────────────── 컴퓨터 ─────────────────────────

/** 0~1 : 손패가 강하다고 느끼는 정도 (자기 손패/상대의 공개 정보만 사용) */
function confidence(g: PracticeGame, seat: number, rng: Rng): number {
  const alive = g.hand!.seats.map((x, i) => (x.inHand && !x.folded ? i : -1)).filter((i) => i >= 0)
  const opponents = alive.filter((i) => i !== seat)
  let s: number
  if (g.opts.mode === 'A') {
    s = handStrength(g.cards[seat]!, g.opts.rules ?? 'standard')
    // 상대의 공개 카드가 높으면 조금 불안하다 (일반: 9 이상 / 섯다: 7~10월 카드)
    const lim = (g.opts.rules ?? 'standard') === 'seotda' ? 13 : 9
    const high = opponents.filter((o) => g.cards[o]![g.openIdx[o] - 1] >= lim).length
    s -= 0.03 * high
  } else {
    // B 모드: 내 카드는 모른다. 상대 카드에서 얻는 정보만 쓴다 (상대가 페어면 내가 높은 카드를 가졌을 확률이 줄어든다)
    const seotda = (g.opts.rules ?? 'standard') === 'seotda'
    const num = (v: number) => (seotda ? Math.ceil(v / 2) : v) // 카드의 숫자(월)
    const pairs = opponents.filter((o) => num(g.cards[o]![0]) === num(g.cards[o]![1])).length
    const avg = opponents.reduce((a, o) => a + (num(g.cards[o]![0]) + num(g.cards[o]![1])), 0) / Math.max(1, opponents.length)
    s = 0.5 - 0.08 * pairs + (11 - avg / 2) * 0.012
  }
  s += (rng() - 0.5) * 0.2
  if (rng() < 0.08) s += 0.3 // 가끔 허세
  return s
}

export function botAction(g: PracticeGame, seat: number, rng: Rng = Math.random): Action {
  const hand = g.hand!
  const legal: LegalActions = legalActions(hand, seat)
  const s = confidence(g, seat, rng)
  const raiseAmt = (): number => Math.max(1, Math.min(legal.raiseMax, s > 0.9 ? 3 : s > 0.78 ? 2 : 1))
  if (legal.canCheck) {
    if (legal.canRaise && s > 0.68) return { type: legal.raiseKind, amount: raiseAmt() }
    return { type: 'check' }
  }
  const cheap = legal.callAmount <= 1
  if (s < 0.34 && !(cheap && rng() < 0.4)) return { type: 'die' }
  if (legal.canRaise && s > 0.8 && rng() < 0.6) return { type: legal.raiseKind, amount: raiseAmt() }
  return { type: 'call' }
}

export { MAX_HANDS }
