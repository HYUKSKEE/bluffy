import { useEffect, useRef, useState } from 'react'
import { friendly } from '../lib/api'
import { useChat } from '../lib/hooks'

/**
 * 채팅 (텍스트로만 표시 — HTML 은 해석하지 않는다).
 * 참가자 채널과 관전자 채널은 서버에서 분리되어 서로 보이지 않는다.
 * bottom: 하단 고정 버튼(행동 바)과 겹치지 않도록 띄우는 높이(px).
 */
export default function ChatPanel({ matchId, bottom = 16 }: { matchId: string; bottom?: number }) {
  const [open, setOpen] = useState(false)
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

  return (
    <>
      <button
        className="candy candy-blue candy-sm fixed right-3 z-30 !min-h-[44px] !rounded-full !px-4"
        style={{ bottom }}
        onClick={() => setOpen(true)}
        aria-label={`채팅 열기${unread > 0 ? ` (새 메시지 ${unread}개)` : ''}`}
      >
        💬{unread > 0 && <span className="ml-1 rounded-full bg-red px-1.5 text-xs">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className="fixed inset-x-0 bottom-0 z-40 px-3 pb-3" role="dialog" aria-label={title}>
          <div className="jelly-panel animate-pop mx-auto flex max-h-[55dvh] max-w-md flex-col p-3">
            <div className="mb-2 flex items-start justify-between gap-2">
              <div>
                <b className="text-lg font-normal">{title}</b>
                <p className="text-xs text-muted">{hint}</p>
              </div>
              <button className="candy candy-dark candy-sm !min-h-[36px] !px-3" onClick={() => setOpen(false)} aria-label="채팅 닫기">닫기</button>
            </div>
            <ul ref={list} className="mb-2 min-h-[6rem] flex-1 space-y-1.5 overflow-y-auto text-sm" aria-live="polite">
              {messages.length === 0 && <li className="py-4 text-center text-muted">아직 대화가 없어요. 먼저 인사해 보세요!</li>}
              {messages.map((m) => (
                <li key={m.id} className={m.mine ? 'text-right' : ''}>
                  <span className={`inline-block max-w-[85%] break-words rounded-2xl px-3 py-1.5 text-left ${m.mine ? 'bg-blue/30' : 'bg-surface2'}`}>
                    {!m.mine && <b className="mr-1.5 font-normal text-blue-soft">{m.nickname}</b>}
                    {m.body}
                  </span>
                </li>
              ))}
            </ul>
            {err && <p role="alert" className="mb-1 text-xs text-red-soft">{err}</p>}
            <form onSubmit={submit} className="flex gap-2">
              <input className="field !min-h-[44px] flex-1 !py-2 text-sm" maxLength={80} placeholder="메시지 (최대 80자)" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" aria-label="채팅 입력" />
              <button className="candy candy-sm !min-h-[44px]" disabled={busy || text.trim().length === 0}>전송</button>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
