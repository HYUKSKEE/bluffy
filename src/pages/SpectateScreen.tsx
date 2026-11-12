import { lazy, Suspense, useState } from 'react'
import { friendly, isConnectionError, type SeatInfo } from '../lib/api'
import { useSpectate, useTicker } from '../lib/hooks'
import { Chips, ErrorScreen, PileBadge, RulesModal, Spinner } from '../components/ui'
import type { StageOpp } from '../components/MatchStage'

const MatchStage = lazy(() => import('../components/MatchStage'))

const ACTION_LABEL = { check: '체크', bet: '베팅', raise: '레이즈', call: '콜', die: '다이' } as const
const short = (s: string) => (s.length > 7 ? s.slice(0, 7) + '…' : s)

/** 읽기 전용 관전 화면. 참여 중인 모든 좌석의 카드가 보인다. */
export default function SpectateScreen({ matchId, onExit }: { matchId: string; onExit: () => void }) {
  const { state, error, refresh } = useSpectate(matchId)
  useTicker(500)
  const [rules, setRules] = useState(false)

  if (error && !state) {
    return isConnectionError(error)
      ? <ErrorScreen onRetry={() => void refresh()} />
      : <ErrorScreen title="관전할 수 없어요" message={friendly(error)} onRetry={onExit} />
  }
  if (!state) return <Spinner label="테이블을 여는 중..." />

  const m = state.match
  const h = state.hand
  const betting = h?.status === 'betting'
  const finishedHand = h?.status === 'finished'
  const over = m.status === 'finished' || m.status === 'void'
  const res = h?.result ?? null
  const winnerSeats = new Set(res?.winners.map((w) => w.seat) ?? [])
  const shown = new Map(state.seat_cards.map((c) => [c.seat, c]))
  const tagsOn = !h?.revealed // 판이 끝나 패가 공개되면 구분 표식은 필요 없다
  const nameOfSeat = (seat: number) => state.seats.find((s) => s.seat === seat)?.nickname ?? '?'

  const stageOpps: StageOpp[] = state.seats.map((o) => {
    const out = !o.in_hand || o.left
    const tail = o.left ? ' 나감' : !o.in_hand ? ' 탈락' : o.folded ? ' 다이' : ''
    const sc = shown.get(o.seat)
    return {
      id: o.player_id,
      label: `${short(o.nickname)} · ${o.chips}${tail}`,
      cards: out ? [] : [0, 1].map((i) => ({
            value: sc?.cards[i] ?? null,
            // A: 상대에게 공개된 카드 / 본인만 아는 카드, B: 본인만 모르는 카드
            tag: !tagsOn || !sc ? null : m.mode === 'B' ? '본인 모름' : sc.open === i + 1 ? '공개' : '비공개',
          })),
      folded: o.folded,
      out,
      active: Boolean(betting && h!.turn_seat === o.seat),
      win: finishedHand && winnerSeats.has(o.seat),
    }
  })

  const statusTag = (o: SeatInfo) =>
    o.left ? '나감' : !o.in_hand ? (o.chips === 0 ? '탈락' : '') : o.folded ? '다이' : betting && h!.turn_seat === o.seat ? '생각 중' : ''

  const standings = [...state.seats].sort((a, b) => Number(a.left) - Number(b.left) || b.chips - a.chips || a.seat - b.seat)

  return (
    <main className="page flex min-h-[100dvh] flex-col pb-8 pt-3">
      <header className="flex items-center justify-between gap-2">
        <button className="candy candy-dark candy-sm !min-h-[40px] !px-3 !py-2 text-sm" onClick={onExit}>나가기</button>
        <div className="text-center text-sm text-muted">
          <span className="tag">👀 관전 중</span>
          <span className="ml-2">{Math.max(1, m.hand_no)} / {m.max_hands} 판 · 앤티 {Math.max(1, m.hand_no)} · {state.seats.filter((s) => !s.left).length}명</span>
        </div>
        <button className="candy candy-dark candy-sm !min-h-[40px] !px-3 !py-2 text-sm" onClick={() => setRules(true)}>규칙</button>
      </header>
      <RulesModal forceOpen={rules} onClose={() => setRules(false)} />

      <PileBadge pile={state.pile} />

      <ul className="mt-3 flex flex-wrap gap-2" aria-label="참가자 현황">
        {state.seats.map((o) => {
          const t = statusTag(o)
          const active = Boolean(betting && h!.turn_seat === o.seat)
          return (
            <li key={o.player_id} className={`jelly-panel flex min-w-0 flex-1 basis-[calc(50%-4px)] items-center justify-between gap-2 !rounded-2xl px-3 py-2 text-sm ${active ? 'ring-2 ring-red' : ''} ${o.left || (!o.in_hand && o.chips === 0) ? 'opacity-50' : ''}`}>
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

      <section className="relative my-2 h-[46dvh] min-h-[320px] w-full" aria-label="카드 테이블 (관전)">
        <Suspense fallback={<Spinner label="카드를 섞는 중..." />}>
          <MatchStage
            opps={stageOpps}
            me={{ cards: [], win: false, folded: false, active: false, label: '', out: true }}
            pot={h?.pot ?? 0}
            handKey={`${h?.id ?? 'none'}`}
          />
        </Suspense>
        <div className="pointer-events-none absolute bottom-[8%] left-1/2 -translate-x-1/2">
          <div className="rounded-full bg-black/55 px-3 py-1 text-lg backdrop-blur-sm">판돈 <Chips n={h?.pot ?? 0} /></div>
        </div>
        {finishedHand && res && !over && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div key={h!.id + 'b'} className="animate-pop rounded-[32px_32px_36px_24px] bg-blue px-7 py-4 text-center shadow-2xl shadow-blue/40">
              <div className="text-3xl">{res.winners.map((w) => nameOfSeat(w.seat)).join(', ')} 승!</div>
              <div className="mt-1 text-sm opacity-90">{res.reason === 'fold' ? '모두 다이' : '쇼다운'} · 판돈 {res.pot}</div>
            </div>
          </div>
        )}
        <p className="pointer-events-none absolute bottom-1 left-0 right-0 text-center text-xs text-muted">
          관전자는 모든 카드를 볼 수 있어요 — 참가자에게 알려주면 안 돼요!
        </p>
        {tagsOn && h && (
          <p className="pointer-events-none absolute bottom-6 left-0 right-0 text-center text-[11px] text-muted">
            {m.mode === 'A' ? '공개 = 상대들도 보는 카드 · 비공개 = 주인만 아는 카드' : '본인 모름 = 상대들은 보지만 주인은 모르는 카드'}
          </p>
        )}
      </section>

      <ul className="mb-2 min-h-[4rem] space-y-0.5 text-sm text-muted" aria-live="polite">
        {state.actions.slice(-4).map((a) => {
          const what = a.action === 'bet' || a.action === 'raise' ? `${ACTION_LABEL[a.action]} +${a.amount}` : a.action === 'call' ? `콜 (${a.amount})` : ACTION_LABEL[a.action]
          return <li key={a.id} className="animate-pop text-red-soft">{nameOfSeat(a.seat)}: {what}{a.auto ? ' (자동)' : ''}</li>
        })}
      </ul>

      {m.status === 'waiting' && <p className="rounded-2xl bg-surface/80 py-4 text-center text-muted">아직 시작 전이에요. 방장이 시작하면 볼 수 있어요.</p>}
      {over && (
        <div className="jelly-panel animate-pop p-4">
          <h2 className="mb-2 text-center text-2xl">{m.status === 'void' ? '방이 종료되어 무효 처리됐어요' : '매치 종료'}</h2>
          {m.status === 'finished' && (
            <ol className="space-y-1.5" aria-label="최종 순위">
              {standings.map((s, i) => (
                <li key={s.seat} className="flex items-center gap-2 rounded-xl bg-surface/70 px-3 py-2">
                  <span className="w-6 text-center text-muted">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{s.is_winner && '👑 '}{s.nickname}</span>
                  <Chips n={s.chips} />
                </li>
              ))}
            </ol>
          )}
          <button className="candy mt-4 w-full" onClick={onExit}>로비로</button>
        </div>
      )}
    </main>
  )
}
