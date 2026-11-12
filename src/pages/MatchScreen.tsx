import { lazy, Suspense, useMemo, useState } from 'react'
import { api, friendly, isConnectionError, type MatchState, type SeatInfo, type VisibleHand } from '../lib/api'
import { useMatch, useTicker } from '../lib/hooks'
import { anteFor, legalFor, TURN_SECONDS } from '../game/rules'
import { Chips, ErrorScreen, Modal, RulesModal, Spinner } from '../components/ui'
import type { StageCard, StageOpp } from '../components/MatchStage'
import TableWaiting from './TableWaiting'

const MatchStage = lazy(() => import('../components/MatchStage')) // three.js 는 대결 화면에서만 로드

const ACTION_LABEL = { check: '체크', bet: '베팅', raise: '레이즈', call: '콜', die: '다이' } as const

function describe(a: MatchState['actions'][number], name: string) {
  const what =
    a.action === 'bet' || a.action === 'raise' ? `${ACTION_LABEL[a.action]} +${a.amount}` :
    a.action === 'call' ? `콜 (${a.amount})` : ACTION_LABEL[a.action]
  return `${name}: ${what}${a.auto ? ' (자동)' : ''}`
}

/** 서버가 준 보이는 카드 → 3D 무대용 카드. 못 보는 카드는 value=null(뒷면). */
export function toStageCards(v: VisibleHand | null, seat: number, mode: 'A' | 'B', mine: boolean): StageCard[] {
  const row = v?.seats.find((s) => s.seat === seat)
  return [0, 1].map((i) => {
    const value = row?.cards[i] ?? null
    return {
      value,
      tag: mode === 'A' && !v?.revealed && row?.open === i + 1 ? '공개' : null,
      forehead: mine && mode === 'B' && value === null,
    }
  })
}

const short = (s: string) => (s.length > 7 ? s.slice(0, 7) + '…' : s)

export default function MatchScreen({ matchId, myPlayerId, onExit }: { matchId: string; myPlayerId: string; onExit: () => void }) {
  const { state, cards, error, refresh, serverNow } = useMatch(matchId)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [rules, setRules] = useState(false)
  useTicker(200) // 타이머 막대 갱신

  const v = useMemo(() => {
    if (!state) return null
    const mySeat = state.my_seat
    const me = state.seats.find((s) => s.seat === mySeat)!
    // 내 다음 좌석부터 시계방향 = 차례 순서
    const opps = state.seats.filter((s) => s.seat !== mySeat).sort((a, b) => ((a.seat - mySeat + 10) % 10) - ((b.seat - mySeat + 10) % 10))
    return { mySeat, me, opps }
  }, [state])

  if (error && !state) return isConnectionError(error) ? <ErrorScreen onRetry={() => void refresh()} /> : <ErrorScreen title="매치를 불러올 수 없어요" message={friendly(error)} onRetry={onExit} />
  if (!state || !v) return <Spinner label="대결 준비 중..." />

  const m = state.match
  const leave = async () => {
    try { await api.leaveMatch(matchId) } catch { /* 이미 끝난 매치 */ }
    setLeaving(false)
    if (m.status === 'waiting') onExit()
    else void refresh()
  }

  // ───── 대기 테이블 ─────
  if (m.status === 'waiting') return <TableWaiting state={state} myPlayerId={myPlayerId} onLeave={() => void leave()} />

  const { mySeat, me, opps } = v
  const h = state.hand
  const over = m.status !== 'playing'
  const betting = h?.status === 'betting'
  const finishedHand = h?.status === 'finished'
  const myTurn = Boolean(betting && h!.turn_seat === mySeat)
  const nameOfSeat = (seat: number) => state.seats.find((s) => s.seat === seat)?.nickname ?? '?'
  const res = h?.result ?? null
  const legal = betting && me.in_hand && !me.folded
    ? legalFor({ chips: me.chips, committed: me.committed, level: h!.level, raiseCount: h!.raise_count })
    : null

  // 카드는 같은 판의 것만 사용 (판이 막 바뀐 순간의 어긋남 방지)
  const vis = cards && h && cards.hand_id === h.id ? cards : null
  const winnerSeats = new Set(res?.winners.map((w) => w.seat) ?? [])

  const stageOpps: StageOpp[] = opps.map((o) => {
    const out = !o.in_hand || o.left
    const tail = o.left ? ' 나감' : !o.in_hand ? ' 탈락' : o.folded ? ' 다이' : ''
    return {
      id: o.player_id,
      label: `${short(o.nickname)} · ${o.chips}${tail}`,
      cards: out ? [] : toStageCards(vis, o.seat, m.mode, false),
      folded: o.folded,
      out,
      active: Boolean(betting && h!.turn_seat === o.seat),
      win: finishedHand && winnerSeats.has(o.seat),
    }
  })
  const myCards = me.in_hand ? toStageCards(vis, mySeat, m.mode, true) : []

  const remaining = h?.turn_deadline ? Math.max(0, (new Date(h.turn_deadline).getTime() - serverNow()) / 1000) : 0
  const timerPct = betting ? Math.min(100, (remaining / TURN_SECONDS) * 100) : 0

  const doAct = async (action: 'check' | 'bet' | 'raise' | 'call' | 'die', amount = 0) => {
    if (!h || busy) return
    setBusy(true)
    setMsg(null)
    try {
      await api.act(h.id, action, amount)
    } catch (e) {
      setMsg(friendly(e))
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  const banner = (() => {
    if (!finishedHand || !res) return null
    const won = res.winners.find((w) => w.seat === mySeat)
    const net = won ? won.amount - me.committed : 0
    const names = res.winners.map((w) => nameOfSeat(w.seat)).join(', ')
    if (won && net > 0) return { text: '승리!', sub: res.reason === 'fold' ? `모두 다이 · +${net}칩` : `+${net}칩 획득`, tone: 'blue' as const }
    if (won) return { text: '무승부', sub: '판돈을 나눠 가졌어요', tone: 'blue' as const }
    return { text: me.folded ? '다이' : '패배...', sub: `승자: ${names}`, tone: 'red' as const }
  })()

  const standings = [...state.seats].sort((a, b) => Number(a.left) - Number(b.left) || b.chips - a.chips || a.seat - b.seat)
  const iWon = Boolean(state.seats.find((s) => s.seat === mySeat)?.is_winner)
  const myProfit = me.profit

  const statusTag = (o: SeatInfo) =>
    o.left ? '나감' : !o.in_hand ? (o.chips === 0 ? '탈락' : '') : o.folded ? '다이' : betting && h!.turn_seat === o.seat ? '생각 중' : ''

  return (
    <main className="page flex min-h-[100dvh] flex-col pb-[188px] pt-3">
      <header className="flex items-center justify-between gap-2">
        <button className="candy candy-dark candy-sm !min-h-[40px] !px-3 !py-2 text-sm" onClick={() => setLeaving(true)} disabled={over}>나가기</button>
        <div className="text-center text-sm text-muted">
          <span className={`tag ${m.mode === 'B' ? 'tag-red' : ''}`}>{m.mode} 모드</span>
          <span className="ml-2">{Math.max(1, m.hand_no)} / {m.max_hands} 판 · 앤티 {anteFor(Math.max(1, m.hand_no))} · {state.seats.filter((s) => !s.left).length}명</span>
        </div>
        <button className="candy candy-dark candy-sm !min-h-[40px] !px-3 !py-2 text-sm" onClick={() => setRules(true)}>규칙</button>
      </header>
      <RulesModal forceOpen={rules} onClose={() => setRules(false)} />

      {/* 상대 요약 */}
      <ul className="mt-3 flex flex-wrap gap-2" aria-label="상대 현황">
        {opps.map((o) => {
          const t = statusTag(o)
          const active = Boolean(betting && h!.turn_seat === o.seat)
          return (
            <li key={o.player_id} className={`jelly-panel flex min-w-0 flex-1 basis-[calc(50%-4px)] items-center justify-between gap-2 !rounded-2xl px-3 py-2 text-sm ${active ? 'ring-2 ring-red' : ''} ${o.left || !o.in_hand && o.chips === 0 ? 'opacity-50' : ''}`}>
              <span className="min-w-0 truncate">
                {h && h.lead_seat === o.seat && <span className="tag mr-1">선</span>}
                {o.nickname}
              </span>
              <span className="flex flex-none items-center gap-1.5">
                {t && <span className={`tag ${t === '생각 중' ? 'tag-red animate-pulse' : ''}`}>{t}</span>}
                <Chips n={o.chips} />
              </span>
            </li>
          )
        })}
      </ul>

      {/* 3D 무대 */}
      <section className="relative my-2 h-[46dvh] min-h-[320px] w-full" aria-label="카드 테이블">
        <Suspense fallback={<Spinner label="카드를 섞는 중..." />}>
          <MatchStage
            opps={stageOpps}
            me={{ cards: myCards, win: finishedHand && winnerSeats.has(mySeat), folded: me.folded, active: myTurn, label: me.nickname, out: !me.in_hand }}
            pot={h?.pot ?? 0}
            handKey={`${h?.id ?? 'none'}`}
          />
        </Suspense>

        <div className="pointer-events-none absolute bottom-[38%] left-1/2 -translate-x-1/2">
          <div className="animate-pop rounded-full bg-black/55 px-3 py-1 text-lg backdrop-blur-sm">
            판돈 <Chips n={h?.pot ?? 0} />
          </div>
        </div>

        {banner && !over && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div key={h!.id + 'b'} className={`animate-pop rounded-[32px_32px_36px_24px] px-7 py-4 text-center shadow-2xl ${banner.tone === 'blue' ? 'bg-blue shadow-blue/40' : 'bg-red shadow-red/40'}`}>
              <div className="text-4xl">{banner.text}</div>
              {banner.sub && <div className="mt-1 text-sm opacity-90">{banner.sub}</div>}
            </div>
          </div>
        )}
        {m.mode === 'B' && betting && me.in_hand && (
          <p className="pointer-events-none absolute bottom-1 left-0 right-0 text-center text-xs text-muted">내 카드는 이마에 붙어 있어요 — 나는 몰라요!</p>
        )}
        {!me.in_hand && !over && (
          <p className="pointer-events-none absolute bottom-1 left-0 right-0 text-center text-xs text-muted">{me.chips === 0 ? '칩이 없어 탈락했어요. 남은 판을 구경해요.' : '이번 판은 쉬어요.'}</p>
        )}
      </section>

      {/* 행동 로그 */}
      <ul className="mb-2 min-h-[4rem] space-y-0.5 text-sm text-muted" aria-live="polite">
        {state.actions.slice(-4).map((a) => (
          <li key={a.id} className={`animate-pop ${a.seat === mySeat ? 'text-blue-soft' : 'text-red-soft'}`}>{describe(a, nameOfSeat(a.seat))}</li>
        ))}
        {state.actions.length === 0 && betting && <li>{h!.turn_seat === mySeat ? '내가 선이에요! 먼저 행동하세요.' : `${nameOfSeat(h!.turn_seat ?? 0)}님이 선이에요.`}</li>}
      </ul>

      {/* 내 정보 */}
      <div className={`jelly-panel flex items-center justify-between px-4 py-2.5 ${myTurn ? 'ring-4 ring-blue' : ''}`}>
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-full bg-blue" />
          <b className="font-normal">{me.nickname} (나)</b>
          {myTurn && <span className="tag animate-bounceY">내 차례</span>}
          {me.folded && <span className="tag tag-red">다이</span>}
        </div>
        <Chips n={me.chips} className="text-xl" />
      </div>

      {/* 하단 고정 행동 버튼 (엄지 영역) */}
      <div className="fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-bg via-bg/95 to-transparent pt-6">
        <div className="page pb-safe">
          <div className="mb-3 h-3 overflow-hidden rounded-full bg-surface2 shadow-inner" role="timer" aria-label={`남은 시간 ${Math.ceil(remaining)}초`}>
            <div className={`h-full rounded-full transition-[width] duration-200 ${remaining < 6 ? 'bg-red' : 'bg-blue'}`} style={{ width: `${timerPct}%` }} />
          </div>
          {msg && <p role="alert" className="mb-2 text-center text-sm text-red-soft">{msg}</p>}

          {betting && legal ? (
            <div className="flex flex-col gap-2.5">
              <div className="grid grid-cols-3 gap-2.5">
                {[1, 2, 3].map((n) => (
                  <button key={n} className="candy candy-blue" disabled={!myTurn || busy || !legal.canRaise || n > legal.raiseMax} onClick={() => void doAct(legal.raiseKind, n)}>
                    {legal.raiseKind === 'bet' ? '베팅' : '레이즈'} +{n}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-[1.6fr_1fr] gap-2.5">
                {legal.canCall ? (
                  <button className="candy candy-gold" disabled={!myTurn || busy} onClick={() => void doAct('call')}>콜 ({legal.callAmount})</button>
                ) : (
                  <button className="candy candy-gold" disabled={!myTurn || busy} onClick={() => void doAct('check')}>체크</button>
                )}
                <button className="candy" disabled={!myTurn || busy} onClick={() => void doAct('die')}>다이</button>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl bg-surface/80 py-4 text-center text-muted">
              {over ? '대결이 끝났어요' : betting && me.folded ? '다이했어요. 결과를 기다려요...' : betting ? '이번 판은 쉬어요' : finishedHand ? '다음 판을 준비하고 있어요...' : '잠시만요...'}
            </div>
          )}
        </div>
      </div>

      {/* 매치 종료 */}
      <Modal open={over} onClose={() => undefined} title={m.status === 'void' ? '방이 종료되었어요' : iWon ? '매치 승리!' : '매치 종료'}>
        {m.status === 'void' ? (
          <p className="mb-4 text-muted">방 생성자가 방을 종료해서 이 매치는 무효 처리되었어요.</p>
        ) : (
          <div className="mb-4">
            <div className={`animate-pop mb-3 text-center text-6xl ${(myProfit ?? 0) > 0 ? 'text-blue' : (myProfit ?? 0) < 0 ? 'text-red' : 'text-ink'}`}>
              {myProfit !== null && myProfit > 0 ? `+${myProfit}` : myProfit}
            </div>
            <ol className="space-y-1.5" aria-label="최종 순위">
              {standings.map((s, i) => (
                <li key={s.seat} className={`flex items-center gap-2 rounded-xl px-3 py-2 ${s.seat === mySeat ? 'bg-blue/25 ring-2 ring-blue' : 'bg-surface/70'}`}>
                  <span className="w-6 text-center text-muted">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{s.is_winner && '👑 '}{s.nickname}{s.left && <span className="tag tag-red ml-2">나감</span>}</span>
                  <Chips n={s.chips} />
                  <b className={`w-12 text-right font-normal tabular-nums ${(s.profit ?? 0) > 0 ? 'text-blue' : (s.profit ?? 0) < 0 ? 'text-red' : 'text-muted'}`}>{(s.profit ?? 0) > 0 ? '+' : ''}{s.profit ?? 0}</b>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-center text-sm text-muted">
              수익이 방 랭킹에 반영됐어요{m.end_reason === 'forfeit' ? ' · 나간 사람이 있어 일찍 끝났어요' : ''}
            </p>
          </div>
        )}
        <button className="candy w-full" onClick={onExit}>{m.room_status === 'closed' ? '최종 순위 보기' : '로비로'}</button>
      </Modal>

      <Modal open={leaving} onClose={() => setLeaving(false)} title="정말 나갈까요?">
        <p className="mb-4 leading-relaxed text-muted">나가면 기권 처리돼요. 이번 판에 건 칩은 돌려받지 못하고, 이득은 챙길 수 없고 손해만 반영돼요. 남은 사람들은 계속해요.</p>
        <div className="grid grid-cols-2 gap-3">
          <button className="candy candy-dark" onClick={() => setLeaving(false)}>계속하기</button>
          <button className="candy" onClick={() => void leave()}>나가기</button>
        </div>
      </Modal>
    </main>
  )
}
