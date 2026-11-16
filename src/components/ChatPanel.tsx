import { useEffect, useRef, useState } from 'react'
import { friendly } from '../lib/api'
import { useChat } from '../lib/hooks'

/**
 * 게임 화면 안에 항상 보이는 채팅 목록 + 입력창 (텍스트로만 표시 — HTML 은 해석하지 않는다).
 * 참가자 채널과 관전자 채널은 서버에서 분리되어 서로 보이지 않는다.
 * 접으면 한 줄(마지막 메시지)만 보인다.
 */
export default function ChatPanel({ matchId }: { matchId: string }) {
  const [open, setOpen] = useState(true)
  const { messages, channel, unread, send } = useChat(matchId, open)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    if (open && list.current) list.current.scrollTop = list.current.scrollHeight
  }, [messages, open])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    setErr(null)
    try {
      await send(body)
      setText('')
    } catch (e2) {
      setErr(friendly(e2))
    } finally {
      setBusy(false)
    }
  }

  const title = channel === 'spectate' ? '관전자 채팅' : '테이블 채팅'
  const hint = channel === 'spectate' ? '관전자끼리만 보여요 (참가자에게는 안 보여요)' : '이 테이블에 앉은 사람끼리만 보여요'
  const last = messages[messages.length - 1]

  return (
    <section className="jelly-panel my-2 p-3" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <b className="font-normal">💬 {title}</b>
          {unread > 0 && !open && <span className="ml-2 rounded-full bg-red px-1.5 text-xs">{unread > 9 ? '9+' : unread}</span>}
          {open && <p className="truncate text-xs text-muted">{hint}</p>}
        </div>
        <button className="candy candy-dark candy-sm !min-h-[32px] !px-3 !py-1 text-xs" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? '접기' : '펼치기'}
        </button>
      </div>

      {!open && last && (
        <p className="mt-1 truncate text-sm text-muted">
          <b className="mr-1.5 font-normal text-blue-soft">{last.mine ? '나' : last.nickname}</b>
          {last.body}
        </p>
      )}

      {open && (
        <>
          <ul ref={list} className="my-2 max-h-[7.5rem] min-h-[3.5rem] space-y-1 overflow-y-auto text-sm" aria-live="polite">
            {messages.length === 0 && <li className="py-3 text-center text-muted">아직 대화가 없어요. 먼저 인사해 보세요!</li>}
            {messages.map((m) => (
              <li key={m.id} className={m.mine ? 'text-right' : ''}>
                <span className={`inline-block max-w-[88%] break-words rounded-2xl px-3 py-1 text-left ${m.mine ? 'bg-blue/30' : 'bg-surface2'}`}>
                  {!m.mine && <b className="mr-1.5 font-normal text-blue-soft">{m.nickname}</b>}
                  {m.body}
                </span>
              </li>
            ))}
          </ul>
          {err && <p role="alert" className="mb-1 text-xs text-red-soft">{err}</p>}
          <form onSubmit={submit} className="flex gap-2">
            <input className="field !min-h-[40px] flex-1 !py-1.5 text-sm" maxLength={80} placeholder="메시지 (최대 80자)" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" aria-label="채팅 입력" />
            <button className="candy candy-sm !min-h-[40px]" disabled={busy || text.trim().length === 0}>전송</button>
          </form>
        </>
      )}
    </section>
  )
}
