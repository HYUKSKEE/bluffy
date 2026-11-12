import { lazy, Suspense, useMemo, useState } from 'react'
import { api, friendly, isConnectionError, type MatchState, type VisibleHand } from '../lib/api'
import { useMatch, useTicker } from '../lib/hooks'
import { legalActions, TURN_SECONDS, type BettingState } from '../game/rules'
import { Chips, ErrorScreen, Modal, Spinner } from '../components/ui'
import type { StageCard } from '../components/MatchStage'

const MatchStage = lazy(() => import('../components/MatchStage')) // three.js 는 대결 화면에서만 로드

const ACTION_LABEL = { check: '체크', bet: '베팅', raise: '레이즈', call: '콜', die: '다이' } as const

function describe(a: MatchState['actions'][number], name: string) {
  const what =
    a.action === 'bet' || a.action === 'raise' ? `${ACTION_LABEL[a.action]} +${a.amount}` :
    a.action === 'call' ? `콜 (${a.amount})` : ACTION_LABEL[a.action]
  return `${name}: ${what}${a.auto ? ' (시간 초과)' : ''}`
}

export function toStageCards(v: VisibleHand | null, mode: 'A' | 'B') {
  const mk = (arr: (number | null)[] | undefined, open: 1 | 2 | null | undefined, mine: boolean): StageCard[] =>
    [0, 1].map((i) => {
      const value = arr?.[i] ?? null
      return {
        value,
        tag: mode === 'A' && !v?.revealed && open === i + 1 ? '공개' : null,
        forehead: mine && mode === 'B' && value === null,
      }
    })
  return { me: mk(v?.me, v?.me_open, true), opp: mk(v?.opp, v?.opp_open, false) }
}

export default function MatchScreen({ matchId, myPlayerId, onExit }: { matchId: string; myPlayerId: string; onExit: () => void }) {
  const { state, cards, error, refresh, serverNow } = useMatch(matchId)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  useTicker(200) // 타이머 막대 갱신

  const view = useMemo(() => {
    if (!state) return null
    const m = state.match
    const mine = m.player1.id === myPlayerId ? 1 : 2
    const myName = mine === 1 ? m.player1.nickname : m.player2.nickname
    const oppName = mine === 1 ? m.player2.nickname : m.player1.nickname
    const myChips = mine === 1 ? m.chips1 : m.chips2
    const oppChips = mine === 1 ? m.chips2 : m.chips1
    const h = state.hand
    const myTurn = Boolean(h && h.status === 'betting' && h.turn_player_id === myPlayerId)
    let legal = null as ReturnType<typeof legalActions> | null
    if (h && h.status === 'betting' && h.turn_player_id) {
      const b: BettingState = {
        stacks: [m.chips1, m.chips2],
        committed: [h.committed1, h.committed2],
        pot: h.pot,
        turn: h.turn_player_id === m.player1.id ? 0 : 1,
        raiseCount: h.raise_count,
        checks: h.checks,
      }
      legal = legalActions(b)
    }
    return { m, mine, myName, oppName, myChips, oppChips, h, myTurn, legal }
  }, [state, myPlayerId])

  if (error && !state) return isConnectionError(error) ? <ErrorScreen onRetry={() => void refresh()} /> : <ErrorScreen title="매치를 불러올 수 없어요" message={friendly(error)} onRetry={onExit} />
  if (!state || !view) return <Spinner label="대결 준비 중..." />

  const { m, myName, oppName, myChips, oppChips, h, myTurn, legal } = view
  const nameOf = (pid: string) => (pid === m.player1.id ? m.player1.nickname : m.player2.nickname)
  const finishedHand = h?.status === 'finished'
  const res = h?.result ?? null
  const over = m.status !== 'playing'

  // 카드는 같은 판의 것만 사용 (판이 막 바뀐 순간의 어긋남 방지)
  const v = cards && h && cards.hand_id === h.id ? cards : null
  const stage = toStageCards(v, m.mode)
  const showdown = finishedHand && v?.revealed && res
  const winner: 'me' | 'opp' | 'tie' | null = showdown ? (res.winner_id === null ? 'tie' : res.winner_id === myPlayerId ? 'me' : 'opp') : null

  const remaining = h?.turn_deadline ? Math.max(0, (new Date(h.turn_deadline).getTime() - serverNow()) / 1000) : 0
  const timerPct = h?.status === 'betting' ? Math.min(100, (remaining / TURN_SECONDS) * 100) : 0

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
    const mine = res.winner_id === myPlayerId
    if (res.reason === 'tie') return { text: '무승부', sub: '판돈을 나눠 가졌어요', tone: 'blue' as const }
    if (res.reason === 'fold') return mine
      ? { text: '승리!', sub: `상대가 다이 · 판돈 ${res.pot}칩 획득`, tone: 'blue' as const }
      : { text: '다이', sub: `판돈 ${res.pot}칩을 상대가 가져가요`, tone: 'red' as const }
    if (res.reason === 'forfeit') return mine
      ? { text: '승리!', sub: '상대가 나갔어요', tone: 'blue' as const }
      : { text: '기권', sub: '', tone: 'red' as const }
    return mine
      ? { text: '승리!', sub: `판돈 ${res.pot}칩 획득`, tone: 'blue' as const }
      : { text: '패배...', sub: `판돈 ${res.pot}칩을 잃었어요`, tone: 'red' as const }
  })()

  const myProfit = m.status === 'finished' ? (view.mine === 1 ? m.profit1 : m.profit2) : null
  const iWon = m.winner_id === myPlayerId

  return (
    <main className="page flex min-h-[100dvh] flex-col pb-[188px] pt-3">
      {/* 상단: 상대 정보 */}
      <header className="flex items-center justify-between gap-2">
        <button className="candy candy-dark candy-sm !min-h-[40px] !px-3 !py-2 text-sm" onClick={() => setLeaving(true)} disabled={over}>나가기</button>
        <div className="text-center text-sm text-muted">
          <span className={`tag ${m.mode === 'B' ? 'tag-red' : ''}`}>{m.mode} 모드</span>
          <span className="ml-2">{Math.max(1, m.hand_no)} / {m.max_hands} 판</span>
        </div>
        <span className="w-[72px]" />
      </header>

      <div className={`jelly-panel mt-3 flex items-center justify-between px-4 py-2.5 ${h?.status === 'betting' && !myTurn ? 'ring-2 ring-red' : ''}`}>
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-full bg-red" />
          <b className="font-normal">{oppName}</b>
          {h?.status === 'betting' && !myTurn && <span className="tag tag-red animate-pulse">생각 중</span>}
        </div>
        <Chips n={oppChips} className="text-xl" />
      </div>

      {/* 3D 무대 */}
      <section className="relative my-2 h-[46dvh] min-h-[320px] w-full" aria-label="카드 테이블">
        <Suspense fallback={<Spinner label="카드를 섞는 중..." />}>
          <MatchStage opp={stage.opp} me={stage.me} pot={h?.pot ?? 0} handKey={`${h?.id ?? 'none'}`} winner={winner} />
        </Suspense>

        {/* 판돈 */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 translate-y-[28px]">
          <div className="animate-pop rounded-full bg-black/55 px-3 py-1 text-lg backdrop-blur-sm">
            판돈 <Chips n={h?.pot ?? 0} />
          </div>
        </div>

        {/* 판 결과 연출 */}
        {banner && !over && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div key={h!.id + 'b'} className={`animate-pop rounded-[32px_32px_36px_24px] px-7 py-4 text-center shadow-2xl ${banner.tone === 'blue' ? 'bg-blue shadow-blue/40' : 'bg-red shadow-red/40'}`}>
              <div className="text-4xl">{banner.text}</div>
              {banner.sub && <div className="mt-1 text-sm opacity-90">{banner.sub}</div>}
            </div>
          </div>
        )}
        {m.mode === 'B' && h?.status === 'betting' && (
          <p className="pointer-events-none absolute bottom-1 left-0 right-0 text-center text-xs text-muted">내 카드는 이마에 붙어 있어요 — 나는 몰라요!</p>
        )}
      </section>

      {/* 행동 로그 */}
      <ul className="mb-2 min-h-[3.2rem] space-y-0.5 text-sm text-muted" aria-live="polite">
        {state.actions.slice(-3).map((a) => (
          <li key={a.id} className={`animate-pop ${a.player_id === myPlayerId ? 'text-blue-soft' : 'text-red-soft'}`}>{describe(a, nameOf(a.player_id))}</li>
        ))}
        {state.actions.length === 0 && h?.status === 'betting' && <li>{h.turn_player_id === myPlayerId ? '내가 선이에요! 먼저 행동하세요.' : '상대가 선이에요.'}</li>}
      </ul>

      {/* 내 정보 */}
      <div className={`jelly-panel flex items-center justify-between px-4 py-2.5 ${myTurn ? 'ring-4 ring-blue' : ''}`}>
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-full bg-blue" />
          <b className="font-normal">{myName} (나)</b>
          {myTurn && <span className="tag animate-bounceY">내 차례</span>}
        </div>
        <Chips n={myChips} className="text-xl" />
      </div>

      {/* 하단 고정 행동 버튼 (엄지 영역) */}
      <div className="fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-bg via-bg/95 to-transparent pt-6">
        <div className="page pb-safe">
          {/* 턴 타이머 */}
          <div className="mb-3 h-3 overflow-hidden rounded-full bg-surface2 shadow-inner" role="timer" aria-label={`남은 시간 ${Math.ceil(remaining)}초`}>
            <div className={`h-full rounded-full transition-[width] duration-200 ${remaining < 6 ? 'bg-red' : 'bg-blue'}`} style={{ width: `${timerPct}%` }} />
          </div>
          {msg && <p role="alert" className="mb-2 text-center text-sm text-red-soft">{msg}</p>}

          {h?.status === 'betting' && legal ? (
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
              {over ? '대결이 끝났어요' : finishedHand ? '다음 판을 준비하고 있어요...' : '잠시만요...'}
            </div>
          )}
        </div>
      </div>

      {/* 매치 종료 */}
      <Modal open={over} onClose={() => undefined} title={m.status === 'void' ? '방이 종료되었어요' : m.winner_id === null ? '무승부!' : iWon ? '매치 승리!' : '매치 패배'}>
        {m.status === 'void' ? (
          <p className="mb-4 text-muted">방 생성자가 방을 종료해서 이 매치는 무효 처리되었어요.</p>
        ) : (
          <div className="mb-4 text-center">
            <div className={`animate-pop mb-2 text-6xl ${iWon ? 'text-blue' : m.winner_id === null ? 'text-ink' : 'text-red'}`}>
              {myProfit !== null && myProfit > 0 ? `+${myProfit}` : myProfit}
            </div>
            <p className="text-muted">
              <Chips n={myChips} /> 로 마무리 · 수익이 방 랭킹에 반영됐어요
              {m.end_reason === 'forfeit' && <><br />{iWon ? '상대가 나가서 승리 처리됐어요.' : '기권으로 처리됐어요.'}</>}
            </p>
          </div>
        )}
        <button className="candy w-full" onClick={onExit}>{m.room_status === 'closed' ? '최종 순위 보기' : '로비로'}</button>
      </Modal>

      <Modal open={leaving} onClose={() => setLeaving(false)} title="정말 나갈까요?">
        <p className="mb-4 leading-relaxed text-muted">나가면 기권 처리되어 상대가 승리해요. 이득은 챙길 수 없고 손해만 반영돼요.</p>
        <div className="grid grid-cols-2 gap-3">
          <button className="candy candy-dark" onClick={() => setLeaving(false)}>계속하기</button>
          <button className="candy" onClick={async () => { try { await api.leaveMatch(matchId) } catch { /* 이미 끝난 매치 */ } setLeaving(false); void refresh() }}>나가기</button>
        </div>
      </Modal>
    </main>
  )
}
