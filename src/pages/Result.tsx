import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, friendly, isConnectionError, subscribeSignal, type RankRow, type RoomView } from '../lib/api'
import { ensureAuth } from '../lib/supabase'
import { ErrorScreen, Logo, Spinner } from '../components/ui'
import { RankingList } from './Room'

function Podium({ top, meId }: { top: RankRow[]; meId: string | null }) {
  // 시상대 배치: 2위 - 1위 - 3위
  const slots = [
    { r: top[1], h: 'h-24', color: 'from-blue-soft to-blue', deep: '--c-blue-deep', delay: '.15s' },
    { r: top[0], h: 'h-36', color: 'from-gold to-[#e0a500]', deep: '--c-gold', delay: '0s' },
    { r: top[2], h: 'h-16', color: 'from-red-soft to-red', deep: '--c-red-deep', delay: '.3s' },
  ]
  return (
    <div className="mt-6 grid grid-cols-3 items-end gap-2" aria-label="시상대">
      {slots.map(({ r, h, color, deep, delay }, i) => (
        <div key={i} className="flex flex-col items-center">
          {r ? (
            <>
              <div className="animate-bounceY text-3xl" style={{ animationDelay: delay }}>{r.rank === 1 ? '👑' : ''}</div>
              <div className={`mb-1 max-w-full truncate px-1 text-center ${r.id === meId ? 'rounded-full bg-blue px-3 text-white' : ''}`}>{r.nickname}</div>
              <div className={`mb-2 text-lg tabular-nums ${r.total_profit >= 0 ? 'text-blue' : 'text-red'}`}>{r.total_profit > 0 ? '+' : ''}{r.total_profit}</div>
            </>
          ) : <div className="h-20" />}
          <div
            className={`animate-pop flex w-full items-start justify-center rounded-t-[28px] bg-gradient-to-b ${color} ${h} pt-2 text-4xl text-black/70`}
            style={{ animationDelay: delay, boxShadow: `inset 0 3px 0 rgb(255 255 255/.5), 0 8px 0 rgb(var(${deep}))` }}
          >
            {r?.rank ?? i + 1}
          </div>
        </div>
      ))}
    </div>
  )
}

export default function Result() {
  const { id = '' } = useParams()
  const [view, setView] = useState<RoomView | null>(null)
  const [meId, setMeId] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        await ensureAuth()
        const [v, me] = await Promise.all([api.getRoomView(id), api.myStatus(id)])
        if (alive) { setView(v); setMeId(me.player?.id ?? null); setError(null) }
      } catch (e) { if (alive) setError(e) }
    }
    void load()
    const off = subscribeSignal(`card_room:${id}`, () => void load())
    const t = setInterval(load, 6000)
    return () => { alive = false; off(); clearInterval(t) }
  }, [id])

  if (error && !view) return <ErrorScreen onRetry={() => setError(null)} title={isConnectionError(error) ? undefined : '결과를 볼 수 없어요'} message={isConnectionError(error) ? undefined : friendly(error)} />
  if (!view) return <Spinner />

  const closed = view.room.status === 'closed'
  const me = view.ranking.find((r) => r.id === meId)

  return (
    <main className="page pb-10 pt-5">
      <header className="flex items-center justify-between"><Logo small /><span className={`tag ${closed ? 'tag-red' : ''}`}>{closed ? '최종 결과' : '진행 중'}</span></header>
      <h1 className="mt-4 text-3xl">{view.room.title}</h1>
      <p className="text-sm text-muted">{closed ? '방이 종료되어 순위가 확정되었어요' : '아직 진행 중인 방이에요. 현재 순위예요.'}</p>

      <Podium top={view.ranking.slice(0, 3)} meId={meId} />

      {me && (
        <div className="jelly-panel animate-pop mt-6 p-4 text-center ring-4 ring-blue">
          <div className="text-sm text-blue-soft">내 순위</div>
          <div className="text-5xl">{me.rank}위</div>
          <div className="text-muted">{me.nickname} · 수익 <b className={me.total_profit >= 0 ? 'text-blue' : 'text-red'}>{me.total_profit > 0 ? '+' : ''}{me.total_profit}</b> · {me.matches_won}승 / {me.matches_played}매치</div>
        </div>
      )}

      <section className="mt-6">
        <h2 className="mb-3 text-2xl">전체 순위</h2>
        <RankingList rows={view.ranking} meId={meId} />
      </section>

      <div className="mt-8 flex flex-col gap-3">
        {!closed && <Link to={`/r/${id}`} className="candy no-underline">방으로 돌아가기</Link>}
        <Link to="/create" className="candy candy-blue no-underline">새 방 만들기</Link>
      </div>
    </main>
  )
}
