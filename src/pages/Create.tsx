import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, friendly, isConnectionError, saveAdminToken, type Mode } from '../lib/api'
import { CopyButton, ErrorScreen, Logo } from '../components/ui'

const MODES: { id: Mode; name: string; tagline: string; desc: string; tone: 'red' | 'blue' }[] = [
  { id: 'A', name: 'A 모드 · 반공개', tagline: '정보는 적당히, 눈치는 팽팽하게', desc: '카드 2장 중 1장은 공개, 1장은 비공개. 나는 내 카드 2장과 각 상대의 공개 카드 1장을 봐요.', tone: 'blue' },
  { id: 'B', name: 'B 모드 · 눈치', tagline: '내 카드는 이마에! 상대 표정을 읽어라', desc: '모든 상대의 카드 2장이 보이고, 내 카드는 보이지 않아요. 상대들의 베팅이 유일한 힌트!', tone: 'red' },
]

export default function Create() {
  const nav = useNavigate()
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<Mode>('A')
  const [hard, setHard] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [conn, setConn] = useState(false)
  const [made, setMade] = useState<{ roomId: string; token: string } | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const r = await api.createRoom(title.trim(), mode, hard)
      saveAdminToken(r.room_id, r.admin_token)
      setMade({ roomId: r.room_id, token: r.admin_token })
    } catch (e2) {
      if (isConnectionError(e2)) setConn(true)
      else setErr(friendly(e2))
    } finally {
      setBusy(false)
    }
  }

  if (conn) return <ErrorScreen onRetry={() => setConn(false)} />

  if (made) {
    const origin = window.location.origin
    const share = `${origin}/r/${made.roomId}`
    const admin = `${origin}/r/${made.roomId}/admin#t=${made.token}`
    return (
      <main className="page py-6">
        <Logo small />
        <div className="jelly-panel animate-pop mt-6 p-5">
          <h1 className="mb-1 text-2xl">방이 만들어졌어요!</h1>
          <p className="mb-5 text-muted">공유 링크를 친구들에게 보내세요.</p>

          <label className="mb-1 block text-sm text-blue-soft">공유 링크 (참가자용)</label>
          <input className="field mb-2 text-sm" readOnly value={share} onFocus={(e) => e.currentTarget.select()} />
          <CopyButton text={share} label="공유 링크 복사" className="mb-6 w-full" />

          <label className="mb-1 block text-sm text-red-soft">관리 링크 (나만 보관!)</label>
          <input className="field mb-2 text-sm" readOnly value={admin} onFocus={(e) => e.currentTarget.select()} />
          <CopyButton text={admin} label="관리 링크 복사" className="mb-2 w-full" />
          <p className="mb-6 text-sm leading-relaxed text-muted">
            관리 링크로만 방을 종료할 수 있어요. 잃어버리면 다시 볼 수 없으니 꼭 저장해두세요. (이 브라우저에는 자동 저장돼요)
          </p>

          <div className="flex flex-col gap-3">
            <button className="candy" onClick={() => nav(`/r/${made.roomId}`)}>나도 입장하기</button>
            <Link to={`/r/${made.roomId}/admin`} className="candy candy-dark no-underline">관리 화면</Link>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="page py-6">
      <Logo small />
      <form onSubmit={submit} className="mt-6 flex flex-col gap-5">
        <h1 className="text-3xl">방 만들기</h1>
        <div>
          <label htmlFor="title" className="mb-2 block text-blue-soft">방 제목</label>
          <input id="title" className="field" maxLength={40} placeholder="예: 금요일 점심내기" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
        </div>

        <fieldset>
          <legend className="mb-2 text-blue-soft">모드 선택 (방 안의 모든 대결에 적용)</legend>
          <div className="flex flex-col gap-3">
            {MODES.map((m) => {
              const on = mode === m.id
              return (
                <label key={m.id} className={`jelly-panel block cursor-pointer p-4 transition-transform ${on ? (m.tone === 'blue' ? 'ring-4 ring-blue' : 'ring-4 ring-red') + ' -translate-y-1' : 'opacity-80'}`}>
                  <input type="radio" name="mode" className="sr-only" checked={on} onChange={() => setMode(m.id)} />
                  <div className="mb-1 flex items-center justify-between">
                    <b className={`text-xl font-normal ${m.tone === 'blue' ? 'text-blue' : 'text-red'}`}>{m.name}</b>
                    {on && <span className={`tag ${m.tone === 'red' ? 'tag-red' : ''}`}>선택됨</span>}
                  </div>
                  <p className="mb-1 text-sm text-ink">{m.tagline}</p>
                  <p className="text-sm leading-relaxed text-muted">{m.desc}</p>
                </label>
              )
            })}
          </div>
        </fieldset>

        <label className={`jelly-panel block cursor-pointer p-4 ${hard ? 'ring-4 ring-gold -translate-y-1' : 'opacity-80'}`}>
          <div className="flex items-center justify-between">
            <b className="text-xl font-normal text-gold">고난이도 · 덱 순환</b>
            <input type="checkbox" className="h-6 w-6 accent-[#ffc94d]" checked={hard} onChange={(e) => setHard(e.target.checked)} aria-label="고난이도 모드" />
          </div>
          <p className="mb-1 text-sm text-ink">쓴 카드를 기억하는 카운팅 게임</p>
          <p className="text-sm leading-relaxed text-muted">덱을 매 판 섞지 않고 이어서 써요. 쓴 카드는 다시 볼 수 없고 남은 장수만 보여요. 덱이 바닥나기 전 &quot;셔플 예고 카드&quot;가 나오면 그 판 뒤에 새로 섞어요.</p>
        </label>

        {err && <p role="alert" className="rounded-2xl bg-red/20 px-4 py-3 text-red-soft">{err}</p>}
        <button className="candy w-full text-xl" disabled={busy || title.trim().length === 0}>
          {busy ? '만드는 중...' : '방 만들기'}
        </button>
      </form>
    </main>
  )
}
