import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, friendly, isConnectionError, loadAdminToken, saveAdminToken, subscribeSignal, type RoomView } from '../lib/api'
import { ensureAuth } from '../lib/supabase'
import { ErrorScreen, Logo, Modal, Spinner } from '../components/ui'
import { RankingList } from './Room'

export default function Admin() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const loc = useLocation()
  const [view, setView] = useState<RoomView | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [ok, setOk] = useState<boolean | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // 관리 링크의 #t=... (fragment 는 서버로 전송되지 않는다) → 브라우저에 저장하고 주소창에서는 지운다
  useEffect(() => {
    const m = /[#&]t=([0-9a-f]+)/.exec(loc.hash)
    if (m) {
      saveAdminToken(id, m[1])
      setToken(m[1])
      window.history.replaceState(null, '', `/r/${id}/admin`)
    } else setToken(loadAdminToken(id))
  }, [id, loc.hash])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        await ensureAuth()
        const v = await api.getRoomView(id)
        if (alive) { setView(v); setError(null) }
      } catch (e) { if (alive) setError(e) }
    }
    void load()
    const off = subscribeSignal(`card_room:${id}`, () => void load())
    const t = setInterval(load, 5000)
    return () => { alive = false; off(); clearInterval(t) }
  }, [id])

  useEffect(() => {
    if (!token) { setOk(false); return }
    api.verifyAdmin(id, token).then(setOk).catch((e) => setError(e))
  }, [id, token])

  if (error && !view) return <ErrorScreen onRetry={() => setError(null)} title={isConnectionError(error) ? undefined : '방을 열 수 없어요'} message={isConnectionError(error) ? undefined : friendly(error)} />
  if (!view || ok === null) return <Spinner />

  if (!ok) {
    return (
      <main className="page py-6">
        <Logo small />
        <div className="jelly-panel mt-6 p-5 text-center">
          <h1 className="mb-2 text-2xl">관리 권한이 없어요</h1>
          <p className="mb-4 text-muted">방을 만들 때 받은 <b className="text-ink">관리 링크</b>로 접속해주세요.</p>
          <Link to={`/r/${id}`} className="candy no-underline">방으로 가기</Link>
        </div>
      </main>
    )
  }

  const closed = view.room.status === 'closed'
  const close = async () => {
    if (!token) return
    setBusy(true)
    setMsg(null)
    try {
      await api.closeRoom(id, token)
      setConfirm(false)
      nav(`/r/${id}/result`)
    } catch (e) { setMsg(friendly(e)) } finally { setBusy(false) }
  }

  return (
    <main className="page pb-10 pt-5">
      <header className="flex items-center justify-between"><Logo small /><span className="tag tag-red">관리</span></header>
      <h1 className="mt-4 text-3xl">{view.room.title}</h1>
      <p className="text-sm text-muted">{view.room.mode === 'A' ? 'A 모드 · 반공개' : 'B 모드 · 눈치'} · {closed ? '종료됨' : '진행 중'}</p>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="jelly-panel p-4 text-center"><div className="text-4xl text-blue tabular-nums">{view.participants}</div><div className="text-sm text-muted">참가자</div></div>
        <div className="jelly-panel p-4 text-center"><div className="text-4xl text-red tabular-nums">{view.active_matches}</div><div className="text-sm text-muted">진행 중 매치</div></div>
      </div>

      <section className="mt-6">
        <h2 className="mb-3 text-2xl">랭킹</h2>
        <RankingList rows={view.ranking} />
      </section>

      <section className="mt-8 flex flex-col gap-3">
        {closed ? (
          <Link to={`/r/${id}/result`} className="candy no-underline">최종 순위 보기</Link>
        ) : (
          <button className="candy" onClick={() => setConfirm(true)}>방 종료하기</button>
        )}
        <Link to={`/r/${id}`} className="text-center text-sm text-muted underline underline-offset-4">참가자 화면으로</Link>
      </section>

      <Modal open={confirm} onClose={() => setConfirm(false)} title="방을 종료할까요?">
        <p className="mb-4 leading-relaxed text-muted">
          진행 중인 매치 <b className="text-ink">{view.active_matches}건</b>은 무효 처리되고 수익이 반영되지 않아요. 최종 순위가 확정되며, 되돌릴 수 없어요.
        </p>
        {msg && <p role="alert" className="mb-3 text-red-soft">{msg}</p>}
        <div className="grid grid-cols-2 gap-3">
          <button className="candy candy-dark" onClick={() => setConfirm(false)}>취소</button>
          <button className="candy" onClick={close} disabled={busy}>{busy ? '종료 중...' : '종료'}</button>
        </div>
      </Modal>
    </main>
  )
}
