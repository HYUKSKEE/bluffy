import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, friendly, GameError, isConnectionError, type RankRow } from '../lib/api'
import { ensureAuth } from '../lib/supabase'
import { useRoom, useTables } from '../lib/hooks'
import { Chips, CopyButton, ErrorScreen, Logo, RulesModal, Spinner } from '../components/ui'
import MatchScreen from './MatchScreen'
import SpectateScreen from './SpectateScreen'

const NICK_KEY = 'bluffy_nick'

export function RankingList({ rows, meId, empty }: { rows: RankRow[]; meId?: string | null; empty?: string }) {
  if (rows.length === 0) return <p className="py-4 text-center text-muted">{empty ?? '아직 참가자가 없어요.'}</p>
  return (
    <ol className="space-y-2">
      {rows.map((r) => {
        const me = r.id === meId
        return (
          <li key={r.id} className={`flex items-center gap-3 rounded-2xl px-3 py-2.5 ${me ? 'bg-blue/25 ring-2 ring-blue' : 'bg-surface/70'}`}>
            <span className={`flex h-9 w-9 flex-none items-center justify-center rounded-full text-lg ${r.rank === 1 ? 'bg-gold text-[#3a2600]' : r.rank === 2 ? 'bg-blue-soft text-blue-deep' : r.rank === 3 ? 'bg-red-soft text-red-deep' : 'bg-surface2'}`}>{r.rank}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate">{r.nickname}{me && <span className="tag ml-2">나</span>}</div>
              <div className="text-xs text-muted">{r.matches_won}승 / {r.matches_played}매치{r.status === 'playing' ? ' · 대결 중' : r.status === 'queued' ? ' · 대기 중' : ''}</div>
            </div>
            <b className={`font-normal text-lg tabular-nums ${r.total_profit > 0 ? 'text-blue' : r.total_profit < 0 ? 'text-red' : 'text-muted'}`}>
              {r.total_profit > 0 ? '+' : ''}{r.total_profit}
            </b>
          </li>
        )
      })}
    </ol>
  )
}

export default function Room() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const { view, player, matchId, error, refresh, setPlayer, setMatchId } = useRoom(id)
  const [authFail, setAuthFail] = useState(false)
  const [nick, setNick] = useState(() => { try { return localStorage.getItem(NICK_KEY) ?? '' } catch { return '' } })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [rules, setRules] = useState(false)
  const [inMatch, setInMatch] = useState<string | null>(null)
  const [watching, setWatching] = useState<string | null>(null)
  const tables = useTables(id, Boolean(player) && !inMatch && !watching)

  useEffect(() => { ensureAuth().catch(() => setAuthFail(true)) }, [])
  // 재접속 시 진행 중인 매치로 자동 복귀
  useEffect(() => { if (matchId && !inMatch) setInMatch(matchId) }, [matchId, inMatch])
  useEffect(() => { if (view?.room.status === 'closed' && !inMatch) nav(`/r/${id}/result`, { replace: true }) }, [view?.room.status, inMatch, id, nav])

  if (authFail || (error && !view)) {
    if (isConnectionError(error) || authFail) return <ErrorScreen onRetry={() => { setAuthFail(false); void ensureAuth().catch(() => setAuthFail(true)); void refresh() }} />
    return <ErrorScreen title="방을 열 수 없어요" message={friendly(error)} />
  }
  if (!view || player === undefined) return <Spinner label="방에 들어가는 중..." />

  if (watching && player) return <SpectateScreen matchId={watching} onExit={() => { setWatching(null); void refresh() }} />

  if (inMatch && player) {
    return <MatchScreen matchId={inMatch} myPlayerId={player.id} onExit={() => { setInMatch(null); setMatchId(null); void refresh() }} />
  }

  const room = view.room

  const join = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      const p = await api.joinRoom(id, nick.trim())
      try { localStorage.setItem(NICK_KEY, nick.trim()) } catch { /* noop */ }
      setPlayer(p)
      void refresh()
    } catch (err) {
      if (err instanceof GameError && err.code === 'ROOM_CLOSED') nav(`/r/${id}/result`, { replace: true })
      else setMsg(friendly(err))
    } finally { setBusy(false) }
  }

  // ───── 1) 닉네임 입력 ─────
  if (!player) {
    return (
      <main className="page py-6">
        <RulesModal />
        <Logo small />
        <form onSubmit={join} className="jelly-panel animate-pop mt-6 p-5">
          <p className="mb-1 text-sm text-blue-soft">초대받은 방</p>
          <h1 className="mb-1 text-3xl">{room.title}</h1>
          <p className="mb-5"><span className={`tag ${room.mode === 'B' ? 'tag-red' : ''}`}>{room.mode === 'A' ? 'A 모드 · 반공개' : 'B 모드 · 눈치'}</span><span className="ml-2 text-sm text-muted">{view.participants}명 참가 중</span></p>
          <label htmlFor="nick" className="mb-2 block">닉네임</label>
          <input id="nick" className="field mb-4" maxLength={12} placeholder="최대 12자" value={nick} onChange={(e) => setNick(e.target.value)} autoComplete="nickname" autoFocus />
          {msg && <p role="alert" className="mb-3 rounded-2xl bg-red/20 px-4 py-3 text-red-soft">{msg}</p>}
          <button className="candy w-full text-xl" disabled={busy || nick.trim().length === 0}>{busy ? '입장 중...' : '입장하기'}</button>
          <button type="button" className="mt-4 w-full text-center text-muted underline underline-offset-4" onClick={() => setRules(true)}>규칙 보기</button>
        </form>
        <RulesModal forceOpen={rules} onClose={() => setRules(false)} />
      </main>
    )
  }

  // ───── 2) 로비 ─────
  // 대결 찾기: 대기 중인 테이블(5명 미만)에 앉거나, 없으면 새 테이블을 열고 내가 방장이 된다.
  const findTable = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.queueMatch(id)
      setInMatch(r.match_id)
    } catch (err) {
      if (err instanceof GameError && err.code === 'ROOM_CLOSED') nav(`/r/${id}/result`, { replace: true })
      else setMsg(friendly(err))
    } finally { setBusy(false); void refresh() }
  }
  const me = view.ranking.find((r) => r.id === player.id)
  const link = `${window.location.origin}/r/${id}`

  return (
    <main className="page pb-10 pt-5">
      <RulesModal forceOpen={rules} onClose={() => setRules(false)} />
      <header className="flex items-center justify-between">
        <Logo small />
        <button className="candy candy-dark candy-sm" onClick={() => setRules(true)}>규칙</button>
      </header>

      <section className="jelly-panel mt-4 p-5">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className={`tag ${room.mode === 'B' ? 'tag-red' : ''}`}>{room.mode} 모드</span>
          <span className="text-sm text-muted">{view.participants}명 · 대결 {view.active_matches}건 진행 중</span>
        </div>
        <h1 className="mb-4 text-3xl">{room.title}</h1>
        <div className="mb-4 flex items-center justify-between rounded-2xl bg-bg/60 px-4 py-3">
          <div>
            <div className="text-sm text-muted">{player.nickname}</div>
            <div className="text-2xl tabular-nums">{me ? `${me.rank}위` : '-'}</div>
          </div>
          <div className="text-right">
            <div className="text-sm text-muted">누적 수익</div>
            <div className={`text-2xl tabular-nums ${player.total_profit > 0 ? 'text-blue' : player.total_profit < 0 ? 'text-red' : ''}`}>{player.total_profit > 0 ? '+' : ''}{player.total_profit}</div>
          </div>
        </div>
        {msg && <p role="alert" className="mb-3 text-red-soft">{msg}</p>}
        <button className="candy w-full text-xl" onClick={findTable} disabled={busy}>
          {busy ? '테이블을 찾는 중...' : view.waiting_tables > 0 ? `대결 찾기 (대기 중인 테이블 ${view.waiting_tables}개)` : '대결 찾기'}
        </button>
        <p className="mt-3 text-center text-sm text-muted">2~5명이 한 테이블 · 시작 칩 <Chips n={100} /> · 최대 10판 · 방장이 시작해요</p>
      </section>

      {tables.some((t) => t.status === 'playing') && (
        <section className="mt-6">
          <h2 className="mb-3 text-2xl">진행 중인 테이블</h2>
          <ul className="space-y-2">
            {tables.filter((t) => t.status === 'playing').map((t) => (
              <li key={t.match_id} className="jelly-panel flex items-center justify-between gap-3 !rounded-2xl px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate">{t.players.join(' · ')}</div>
                  <div className="text-xs text-muted">{Math.max(1, t.hand_no)} / {t.max_hands} 판 · {t.seats}명</div>
                </div>
                <button className="candy candy-dark candy-sm flex-none" onClick={() => setWatching(t.match_id)}>👀 관전</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6">
        <h2 className="mb-3 flex items-center justify-between text-2xl">방 랭킹 <span className="text-sm text-muted">실시간</span></h2>
        <RankingList rows={view.ranking} meId={player.id} />
      </section>

      <section className="mt-6 flex flex-col gap-3">
        <CopyButton text={link} label="친구에게 공유할 링크 복사" className="w-full" />
        <Link to={`/r/${id}/admin`} className="text-center text-sm text-muted underline underline-offset-4">방 관리 (생성자 전용)</Link>
      </section>
    </main>
  )
}
