import { useState } from 'react'
import { api, friendly, type MatchState } from '../lib/api'
import { MAX_PLAYERS, MIN_PLAYERS, START_CHIPS } from '../game/rules'
import { Chips, CopyButton } from '../components/ui'

/** 대기 테이블: 2~5명이 모일 때까지 기다리고, 방장이 마음대로 시작한다 (5명이면 자동 시작). */
export default function TableWaiting({ state, myPlayerId, onLeave }: { state: MatchState; myPlayerId: string; onLeave: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const m = state.match
  const isHost = m.host_player_id === myPlayerId
  const count = state.seats.length
  const link = `${window.location.origin}/r/${m.room_id}`

  const start = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await api.startMatch(m.id)
    } catch (e) {
      setMsg(friendly(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="page flex min-h-[100dvh] flex-col pb-10 pt-5">
      <header className="flex items-center justify-between">
        <button className="candy candy-dark candy-sm" onClick={onLeave}>자리 나가기</button>
        <span className={`tag ${m.mode === 'B' ? 'tag-red' : ''}`}>{m.mode === 'A' ? 'A 모드 · 반공개' : 'B 모드 · 눈치'}</span>
      </header>

      <section className="jelly-panel animate-pop mt-5 p-5">
        <h1 className="text-3xl">대결 대기실</h1>
        <p className="mt-1 text-muted">
          {count} / {MAX_PLAYERS}명 · {MAX_PLAYERS}명이 모이면 자동으로 시작해요
        </p>

        <ul className="mt-4 space-y-2" aria-label="앉은 사람">
          {Array.from({ length: MAX_PLAYERS }).map((_, i) => {
            const s = state.seats.find((x) => x.seat === i + 1)
            const me = s?.player_id === myPlayerId
            return (
              <li key={i} className={`flex items-center gap-3 rounded-2xl px-3 py-2.5 ${s ? (me ? 'bg-blue/25 ring-2 ring-blue' : 'bg-surface/80') : 'border-2 border-dashed border-white/10'}`}>
                <span className={`flex h-9 w-9 flex-none items-center justify-center rounded-full text-lg ${s ? 'bg-red text-white' : 'bg-surface2 text-muted'}`}>{i + 1}</span>
                {s ? (
                  <>
                    <span className="min-w-0 flex-1 truncate">{s.nickname}{me && <span className="tag ml-2">나</span>}</span>
                    {s.is_host && <span className="tag tag-red">방장</span>}
                  </>
                ) : (
                  <span className="text-muted">빈 자리</span>
                )}
              </li>
            )
          })}
        </ul>

        <p className="mt-4 text-center text-sm text-muted">
          시작 칩 <Chips n={START_CHIPS} /> · 최대 {state.match.max_hands}판 · 쇼다운 생존자 중 최고 족보가 판돈을 가져가요
        </p>
      </section>

      <section className="mt-5 flex flex-col gap-3">
        {msg && <p role="alert" className="rounded-2xl bg-red/20 px-4 py-3 text-red-soft">{msg}</p>}
        {isHost ? (
          <>
            <button className="candy w-full text-xl" onClick={start} disabled={busy || count < MIN_PLAYERS}>
              {busy ? '시작하는 중...' : `지금 시작하기 (${count}명)`}
            </button>
            {count < MIN_PLAYERS && <p className="text-center text-sm text-muted">{MIN_PLAYERS}명 이상 모이면 시작할 수 있어요. 더 기다려도 좋아요!</p>}
          </>
        ) : (
          <div className="flex items-center justify-center gap-3 rounded-2xl bg-surface/80 py-4 text-muted">
            <span className="coin animate-bounceY" />
            방장이 시작하길 기다리는 중...
          </div>
        )}
        <CopyButton text={link} label="친구 더 부르기 (링크 복사)" className="w-full" />
      </section>
    </main>
  )
}
