import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  act, advance, botAction, newGame, pileInfo, standings, turnSeat,
  type LogItem, type PracticeGame, type PracticeMode, type PracticeOpts,
} from '../game/practice'
import { handName, legalActions, MAX_HANDS } from '../game/rules'
import { playSfx } from '../lib/sound'
import { Chips, Logo, Modal, PileBadge, RulesModal, Spinner } from '../components/ui'
import { SoundButton } from '../components/SoundButton'
import { SeotdaChartButton } from '../components/SeotdaChart'
import type { StageCard, StageOpp } from '../components/MatchStage'

const MatchStage = lazy(() => import('../components/MatchStage'))

const ACTION_LABEL = { check: '체크', bet: '베팅', raise: '레이즈', call: '콜', die: '다이' } as const
const short = (s: string) => (s.length > 8 ? s.slice(0, 8) + '…' : s)

/** 혼자 연습하기: 컴퓨터와 대결. 서버에 접속하지 않고 점수·랭킹에 반영되지 않는다. */
export default function Practice({ onExit }: { onExit?: () => void } = {}) {
  // 주소로 설정을 미리 정할 수 있다: /practice?mode=B&bots=3&hard=1&start=1 (start=1 이면 바로 시작)
  const q = new URLSearchParams(window.location.search)
  const [opts, setOpts] = useState<PracticeOpts>(() => ({
    mode: q.get('mode') === 'B' ? 'B' : q.get('mode') === 'C' ? 'C' : 'A',
    bots: Math.min(4, Math.max(1, Number(q.get('bots')) || 2)),
    hard: q.get('hard') === '1',
    rules: q.get('rules') === 'seotda' ? 'seotda' : 'standard',
  }))
  const [g, setG] = useState<PracticeGame | null>(() => (q.get('start') === '1' ? newGame(opts) : null))
  const [rules, setRules] = useState(false)

  if (!g) return <Setup opts={opts} setOpts={setOpts} onStart={() => setG(newGame(opts))} onExit={onExit} />
  return <Game g={g} setG={setG} rules={rules} setRules={setRules} onRestart={() => setG(newGame(g.opts))} onSetup={() => setG(null)} onExit={onExit} />
}

/** 나가기: 방 안에서 열었으면 방으로 돌아가고, 아니면 처음 화면으로 간다 */
function ExitLink({ onExit, className, children }: { onExit?: () => void; className: string; children: React.ReactNode }) {
  return onExit ? (
    <button type="button" className={className} onClick={onExit}>{children}</button>
  ) : (
    <Link to="/" className={`${className} no-underline`}>{children}</Link>
  )
}

function Setup({ opts, setOpts, onStart, onExit }: { opts: PracticeOpts; setOpts: (o: PracticeOpts) => void; onStart: () => void; onExit?: () => void }) {
  const modes: { id: PracticeMode; name: string; desc: string }[] = [
    { id: 'A', name: 'A 모드 · 반공개', desc: '내 카드 2장 + 상대의 공개 카드 1장이 보여요.' },
    { id: 'B', name: 'B 모드 · 눈치', desc: '상대의 카드 2장이 보이고, 내 카드는 몰라요.' },
    { id: 'C', name: 'C 모드 · 블라인드', desc: '판이 끝나기 전에는 아무 카드도 안 보여요. 베팅만 믿고 가요!' },
  ]
  return (
    <main className="page py-6">
      <div className="flex items-center justify-between">
        <Logo small />
        <SoundButton />
      </div>
      <div className="mt-6 flex flex-col gap-5">
        <div>
          <h1 className="text-3xl">혼자 연습하기</h1>
          <p className="mt-1 rounded-2xl bg-blue/15 px-4 py-3 text-sm leading-relaxed text-blue-soft">
            컴퓨터와 하는 연습 게임이에요. 이 기기에서만 진행되고 <b className="font-normal text-ink">점수·랭킹에 반영되지 않아요.</b>
          </p>
        </div>

        <fieldset>
          <legend className="mb-2 text-blue-soft">모드</legend>
          <div className="flex flex-col gap-2">
            {modes.map((m) => (
              <label key={m.id} className={`jelly-panel block cursor-pointer !rounded-2xl p-3 ${opts.mode === m.id ? 'ring-4 ring-blue' : 'opacity-80'}`}>
                <input type="radio" name="pmode" className="sr-only" checked={opts.mode === m.id} onChange={() => setOpts({ ...opts, mode: m.id })} />
                <b className="font-normal">{m.name}</b>
                <p className="text-sm text-muted">{m.desc}</p>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-blue-soft">컴퓨터 상대 수</legend>
          <div className="grid grid-cols-4 gap-2">
            {[1, 2, 3, 4].map((n) => (
              <button key={n} type="button" className={`candy ${opts.bots === n ? 'candy-blue' : 'candy-dark'}`} onClick={() => setOpts({ ...opts, bots: n })} aria-pressed={opts.bots === n}>
                {n}명
              </button>
            ))}
          </div>
        </fieldset>

        <label className={`jelly-panel block cursor-pointer !rounded-2xl p-3 ${opts.hard ? 'ring-4 ring-gold' : 'opacity-80'}`}>
          <div className="flex items-center justify-between">
            <b className="font-normal text-gold">고난이도 · 덱 순환</b>
            <input type="checkbox" className="h-6 w-6 accent-[#ffc94d]" checked={opts.hard} onChange={(e) => setOpts({ ...opts, hard: e.target.checked })} aria-label="고난이도 모드" />
          </div>
          <p className="text-sm text-muted">덱을 섞지 않고 이어서 써요. 나온 카드를 기억하는 카운팅 연습!</p>
        </label>

        <label className={`jelly-panel block cursor-pointer !rounded-2xl p-3 ${opts.rules === 'seotda' ? 'ring-4 ring-red' : 'opacity-80'}`}>
          <div className="flex items-center justify-between">
            <b className="font-normal text-red">🎴 섯다 룰 · 화투</b>
            <input type="checkbox" className="h-6 w-6 accent-[#ff3b5c]" checked={opts.rules === 'seotda'} onChange={(e) => setOpts({ ...opts, rules: e.target.checked ? 'seotda' : 'standard' })} aria-label="섯다 룰" />
          </div>
          <p className="text-sm text-muted">화투 그림 카드와 섯다 족보(광땡·땡·알리·독사·끗·땡잡이·암행어사)로 연습해요.</p>
        </label>

        <button className="candy w-full text-xl" onClick={onStart}>연습 시작</button>
        <ExitLink onExit={onExit} className="text-center text-muted underline underline-offset-4">{onExit ? '방으로 돌아가기' : '처음으로'}</ExitLink>
      </div>
    </main>
  )
}

function describe(a: LogItem, name: string) {
  const what = a.action === 'bet' || a.action === 'raise' ? `${ACTION_LABEL[a.action]} +${a.amount}` : a.action === 'call' ? `콜 (${a.amount})` : ACTION_LABEL[a.action]
  return `${name}: ${what}`
}

function Game({ g, setG, rules, setRules, onRestart, onSetup, onExit }: {
  g: PracticeGame
  setG: React.Dispatch<React.SetStateAction<PracticeGame | null>>
  rules: boolean
  setRules: (v: boolean) => void
  onRestart: () => void
  onSetup: () => void
  onExit?: () => void
}) {
  const turn = turnSeat(g)
  const betting = g.status === 'betting'
  const finished = g.status === 'finished' || g.status === 'over'
  const over = g.status === 'over'
  const revealed = finished // 판이 끝나면 그 판 참여자 전원의 패가 공개된다
  const hand = g.hand!
  const chipsOf = (i: number) => (betting ? hand.seats[i].chips : g.chips[i])
  const winnerSeats = new Set(g.result?.winners.map((w) => w.seat) ?? [])
  const mode = g.opts.mode
  const seotda = g.opts.rules === 'seotda'

  // ── 컴퓨터 차례: 잠깐 생각한 뒤 행동 ──
  useEffect(() => {
    if (!betting || turn === null || turn === 0) return
    const id = setTimeout(() => {
      setG((cur) => {
        if (cur !== g) return cur
        return act(cur, turn, botAction(cur, turn)) ?? cur
      })
    }, 650 + Math.random() * 700)
    return () => clearTimeout(id)
  }, [g, betting, turn, setG])

  // ── 판이 끝나면 잠시 보여 주고 다음 판 ──
  useEffect(() => {
    if (g.status !== 'finished') return
    const id = setTimeout(() => setG((cur) => (cur === g ? advance(cur) : cur)), g.result?.reason === 'showdown' ? 5000 : 3500)
    return () => clearTimeout(id)
  }, [g, setG])

  // ── 효과음 ──
  const prev = useRef<{ hand: number; logs: number; status: string; turn: number | null } | null>(null)
  useEffect(() => {
    const p = prev.current
    prev.current = { hand: g.handNo, logs: g.log.length, status: g.status, turn }
    if (!p) return
    if (g.handNo !== p.hand) {
      playSfx(g.opts.hard && g.deck?.fresh ? 'shuffle' : 'deal')
      return
    }
    for (const a of g.log.slice(p.logs)) playSfx(a.action === 'die' ? 'die' : a.action === 'check' ? 'check' : 'chip')
    if (g.status !== 'betting' && p.status === 'betting' && g.result) playSfx(winnerSeats.has(0) ? 'win' : 'lose')
    else if (turn === 0 && p.turn !== 0) playSfx('turn')
  }, [g, turn]) // eslint-disable-line react-hooks/exhaustive-deps

  // 다이한 사람은 남의 패를 못 보고, 다이한 사람의 패도 남이 못 본다 (실제 게임과 같은 규칙)
  const meFolded = hand.seats[0].folded
  const hiddenFromMe = (seat: number) => seat !== 0 && (meFolded || hand.seats[seat].folded)
  const toStage = (seat: number, mine: boolean): StageCard[] => {
    const c = g.cards[seat]
    if (!c || !hand.seats[seat].inHand) return []
    if (hiddenFromMe(seat)) return [{ value: null }, { value: null }]
    return [0, 1].map((i) => {
      if (revealed) return { value: c[i] }
      if (mode === 'C') return { value: null } // 블라인드: 판이 끝나기 전에는 아무것도 안 보인다
      if (mode === 'A') {
        if (mine) return { value: c[i], tag: g.openIdx[seat] === i + 1 ? '공개' : null }
        return g.openIdx[seat] === i + 1 ? { value: c[i], tag: '공개' } : { value: null }
      }
      return mine ? { value: null, forehead: true } : { value: c[i] }
    })
  }

  const opps: StageOpp[] = useMemo(
    () =>
      Array.from({ length: g.n - 1 }, (_, k) => k + 1).map((seat) => {
        const s = hand.seats[seat]
        const out = !s.inHand
        const tail = out ? ' 탈락' : s.folded ? ' 다이' : ''
        return {
          id: String(seat),
          label: `${short(g.names[seat])} · ${chipsOf(seat)}${tail}${seotda && revealed && !out && g.cards[seat] && !hiddenFromMe(seat) ? ` · ${handName(g.cards[seat]!, 'seotda')}` : ''}`,
          cards: out ? [] : toStage(seat, false),
          folded: s.folded,
          out,
          active: betting && turn === seat,
          win: finished && winnerSeats.has(seat),
        }
      }),
    [g], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const me = hand.seats[0]
  const myHandName = seotda && me.inHand && g.cards[0] && (mode === 'A' || revealed) ? handName(g.cards[0], 'seotda') : null
  const pot = hand.carryIn + hand.seats.reduce((a, s) => a + s.committed, 0)
  const legal = betting && me.inHand && !me.folded ? legalActions(hand, 0) : null
  const myTurn = turn === 0
  const banner = (() => {
    if (!finished || !g.result || over) return null
    const won = g.result.winners.find((w) => w.seat === 0)
    const net = won ? won.amount - me.committed : 0
    const names = g.result.winners.map((w) => g.names[w.seat]).join(', ')
    if (won && net > 0) return { text: '승리!', sub: g.result.reason === 'fold' ? `모두 다이 · +${net}칩` : `+${net}칩 획득`, tone: 'blue' as const }
    if (won) return { text: '무승부', sub: '판돈을 나눠 가졌어요', tone: 'blue' as const }
    return { text: me.folded ? '다이' : '패배...', sub: `승자: ${names}`, tone: 'red' as const }
  })()
  const doAct = (action: 'check' | 'bet' | 'raise' | 'call' | 'die', amount = 0) => {
    setG((cur) => {
      if (!cur || cur !== g) return cur
      const a = action === 'bet' || action === 'raise' ? { type: action, amount } : { type: action }
      return act(cur, 0, a as Parameters<typeof act>[2]) ?? cur
    })
  }
  const st = standings(g)
  const myProfit = g.chips[0] - 100

  return (
    <main className="page flex min-h-[100dvh] flex-col pb-[188px] pt-3">
      <header className="flex items-center justify-between gap-2">
        <ExitLink onExit={onExit} className="candy candy-dark candy-sm !min-h-[40px] shrink-0 whitespace-nowrap !px-3 !py-2 text-sm">나가기</ExitLink>
        <div className="flex min-w-0 flex-wrap items-center justify-center gap-x-1 gap-y-0.5 text-center text-xs text-muted">
          <span className="tag">연습</span>
          <span className={`tag ml-1 ${mode !== 'A' ? 'tag-red' : ''}`}>{mode} 모드</span>
          {seotda && <SeotdaChartButton className="ml-1" />}
          <span className="ml-2">{Math.max(1, g.handNo)} / {MAX_HANDS} 판</span>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <SoundButton />
          <button className="candy candy-dark candy-sm !min-h-[40px] shrink-0 whitespace-nowrap !px-3 !py-2 text-sm" onClick={() => setRules(true)}>규칙</button>
        </div>
      </header>
      <RulesModal forceOpen={rules} onClose={() => setRules(false)} />
      <PileBadge pile={pileInfo(g)} />

      <section className="relative my-2 h-[46dvh] min-h-[320px] w-full" aria-label="카드 테이블">
        <Suspense fallback={<Spinner label="카드를 섞는 중..." />}>
          <MatchStage
            opps={opps}
            me={{ cards: toStage(0, true), win: finished && winnerSeats.has(0), folded: me.folded, active: myTurn, label: `나 · ${chipsOf(0)}`, out: !me.inHand, note: myHandName }}
            pot={pot}
            handKey={`${g.handNo}`}
            hwatu={seotda}
          />
        </Suspense>
        <div className="pointer-events-none absolute bottom-[38%] left-1/2 -translate-x-1/2">
          <div className="animate-pop rounded-full bg-black/40 px-2.5 py-0.5 text-sm">
            판돈 <Chips n={pot} />
          </div>
        </div>
        {banner && (
          <div className="pointer-events-none absolute inset-x-0 top-1 flex justify-center">
            <div key={g.handNo + 'b'} className={`animate-pop rounded-full px-4 py-1.5 text-center shadow-lg backdrop-blur-[2px] ${banner.tone === 'blue' ? 'bg-blue/60' : 'bg-red/60'}`}>
              <span className="text-xl">{banner.text}</span>
              <span className="ml-2 text-xs opacity-90">{banner.sub}</span>
            </div>
          </div>
        )}
        {mode === 'C' && betting && me.inHand && (
          <p className="pointer-events-none absolute bottom-1 left-0 right-0 text-center text-xs text-muted">아무 카드도 보이지 않아요 — 베팅만 보고 승부해요!</p>
        )}
        {mode === 'B' && betting && me.inHand && (
          <p className="pointer-events-none absolute bottom-1 left-0 right-0 text-center text-xs text-muted">내 카드는 이마에 붙어 있어요 — 나는 몰라요!</p>
        )}
      </section>

      <ul className="mb-2 min-h-[4rem] space-y-0.5 text-sm text-muted" aria-live="polite">
        {g.log.slice(-4).map((a) => (
          <li key={a.id} className={`animate-pop ${a.seat === 0 ? 'text-blue-soft' : 'text-red-soft'}`}>{describe(a, g.names[a.seat])}</li>
        ))}
        {g.log.length === 0 && betting && <li>{turn === 0 ? '내가 선이에요! 먼저 행동하세요.' : `${g.names[turn ?? 0]}님이 선이에요.`}</li>}
      </ul>

      <div className={`jelly-panel flex items-center justify-between px-4 py-2.5 ${myTurn ? 'ring-4 ring-blue' : ''}`}>
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-full bg-blue" />
          <b className="font-normal">나</b>
          {myHandName && <span className="tag">{myHandName}</span>}
          {myTurn && <span className="tag animate-bounceY">내 차례</span>}
          {me.folded && <span className="tag tag-red">다이</span>}
        </div>
        <Chips n={chipsOf(0)} className="text-xl" />
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-bg via-bg/95 to-transparent pt-6">
        <div className="page pb-safe">
          {betting && legal ? (
            <div className="flex flex-col gap-2.5">
              <div className="grid grid-cols-3 gap-2.5">
                {[1, 2, 3].map((n) => (
                  <button key={n} className="candy candy-blue" disabled={!myTurn || !legal.canRaise || n > legal.raiseMax} onClick={() => doAct(legal.raiseKind, n)}>
                    {legal.raiseKind === 'bet' ? '베팅' : '레이즈'} +{n}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-[1.6fr_1fr] gap-2.5">
                {legal.canCall ? (
                  <button className="candy candy-gold" disabled={!myTurn} onClick={() => doAct('call')}>콜 ({legal.callAmount})</button>
                ) : (
                  <button className="candy candy-gold" disabled={!myTurn} onClick={() => doAct('check')}>체크</button>
                )}
                <button className="candy" disabled={!myTurn} onClick={() => doAct('die')}>다이</button>
              </div>
            </div>
          ) : finished && !over ? (
            <button className="candy w-full" onClick={() => setG((cur) => (cur ? advance(cur) : cur))}>다음 판</button>
          ) : (
            <div className="rounded-2xl bg-surface/80 py-4 text-center text-muted">{over ? '연습이 끝났어요' : betting && me.folded ? '다이했어요. 결과를 기다려요...' : '이번 판은 쉬어요'}</div>
          )}
        </div>
      </div>

      <Modal open={over} onClose={() => undefined} title={st[0].isWinner && st[0].seat === 0 ? '연습 승리!' : '연습 종료'}>
        <p className="mb-3 rounded-xl bg-blue/15 px-3 py-2 text-center text-sm text-blue-soft">연습 게임이라 점수·랭킹에 반영되지 않아요</p>
        <div className={`animate-pop mb-3 text-center text-5xl ${myProfit > 0 ? 'text-blue' : myProfit < 0 ? 'text-red' : 'text-ink'}`}>{myProfit > 0 ? `+${myProfit}` : myProfit}</div>
        <ol className="mb-4 space-y-1.5" aria-label="최종 순위">
          {st.map((s, i) => (
            <li key={s.seat} className={`flex items-center gap-2 rounded-xl px-3 py-2 ${s.seat === 0 ? 'bg-blue/25 ring-2 ring-blue' : 'bg-surface/70'}`}>
              <span className="w-6 text-center text-muted">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{s.isWinner && '👑 '}{s.name}</span>
              <Chips n={s.chips} />
            </li>
          ))}
        </ol>
        <div className="grid grid-cols-2 gap-3">
          <button className="candy candy-dark" onClick={onSetup}>설정 바꾸기</button>
          <button className="candy" onClick={onRestart}>다시 하기</button>
        </div>
        <ExitLink onExit={onExit} className="mt-3 block w-full text-center text-muted underline underline-offset-4">{onExit ? '방으로 돌아가기' : '처음으로'}</ExitLink>
      </Modal>
    </main>
  )
}
