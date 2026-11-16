import { useEffect, useRef, useState } from 'react'
import { EMOTES, emoteOf, friendly } from '../lib/api'
import { useChat } from '../lib/hooks'

const emoteInfo = (key: string) => EMOTES.find((x) => x.key === key)!
const textOf = (body: string) => {
  const k = emoteOf(body)
  return k ? `${emoteInfo(k).emoji} ${emoteInfo(k).text}` : body
}

/**
 * 게임 화면을 가리지 않는 채팅: 최근 대화 몇 줄만 작게 띄우고, 오른쪽 가장자리에
 * 💬 버튼과 빠른 반응(이모지) 버튼을 세로로 둔다. 💬 를 누르면 전체 대화 + 입력창이 열린다.
 * (텍스트로만 표시 — HTML 은 해석하지 않는다. 참가자/관전자 채널은 서버에서 분리된다.)
 * bottom: 화면 하단의 고정 버튼과 겹치지 않도록 띄우는 높이(px).
 */
export default function ChatPanel({ matchId, bottom = 16 }: { matchId: string; bottom?: number }) {
  const [open, setOpen] = useState(false)
  const { messages, channel, unread, send, sendEmote, emote, clearEmote } = useChat(matchId, open)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const emoteBusy = useRef(false)

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

  const doEmote = async (key: (typeof EMOTES)[number]['key']) => {
    if (emoteBusy.current) return
    emoteBusy.current = true
    try {
      await sendEmote(key)
    } catch {
      /* 도배 방지 등 — 조용히 무시 (소리/표시가 안 나는 것으로 충분) */
    } finally {
      setTimeout(() => { emoteBusy.current = false }, 400)
    }
  }

  const title = channel === 'spectate' ? '관전자 채팅' : '테이블 채팅'
  const hint = channel === 'spectate' ? '관전자끼리만 보여요 (참가자에게는 안 보여요)' : '이 테이블에 앉은 사람끼리만 보여요'
  const recent = messages.slice(-3)

  return (
    <>
      {/* 이모지가 왔을 때 잠깐 뜨는 큰 표시 */}
      {emote && (
        <div className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center px-4" aria-live="polite">
          <button type="button" onClick={clearEmote} aria-label="이모지 닫기" key={emote.id} className="animate-pop pointer-events-auto flex items-center gap-2 rounded-full bg-black/45 px-3 py-1.5 shadow-lg">
            <span className="animate-bounceY text-3xl leading-none">{emoteInfo(emote.key).emoji}</span>
            <span className="text-sm">{emote.mine ? '나' : emote.nickname}: {emoteInfo(emote.key).text}</span>
          </button>
        </div>
      )}

      {/* 최근 대화 (작게, 클릭은 통과) */}
      {recent.length > 0 && (
        <ul className="pointer-events-none fixed left-3 right-[64px] z-20 space-y-0.5" style={{ bottom }} aria-label="최근 대화" aria-live="polite">
          {recent.map((m) => (
            <li key={m.id} className={m.mine ? 'text-right' : ''}>
              <span className={`inline-block max-w-full break-words rounded-xl px-2 py-0.5 text-left text-[11px] leading-snug text-white backdrop-blur-sm ${m.mine ? 'bg-blue/60' : 'bg-black/55'}`}>
                {!m.mine && <b className="mr-1 font-normal text-blue-soft">{m.nickname}</b>}
                {textOf(m.body)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* 오른쪽 가장자리: 채팅 버튼 + 이모지 버튼 */}
      <div className="fixed right-2 z-30 flex flex-col items-center gap-1" style={{ bottom }} role="group" aria-label="채팅과 빠른 반응">
        {EMOTES.map((e) => (
          <button
            key={e.key}
            type="button"
            className="flex h-[42px] w-[54px] flex-col items-center justify-center rounded-2xl bg-black/55 leading-none text-white shadow-md backdrop-blur-sm active:scale-95"
            onClick={() => void doEmote(e.key)}
            aria-label={e.text}
          >
            <span className="text-base leading-none">{e.emoji}</span>
            <span className="mt-0.5 whitespace-nowrap text-[9px] leading-none">{e.text}</span>
          </button>
        ))}
        <button
          type="button"
          className="relative flex h-[42px] w-[54px] flex-col items-center justify-center rounded-2xl bg-blue leading-none text-white shadow-md active:scale-95"
          onClick={() => setOpen(true)}
          aria-label={`채팅 열기${unread > 0 ? ` (새 메시지 ${unread}개)` : ''}`}
        >
          <span className="text-base leading-none">💬</span>
          <span className="mt-0.5 text-[9px] leading-none">채팅</span>
          {unread > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-red px-1.5 text-[10px]">{unread > 9 ? '9+' : unread}</span>}
        </button>
      </div>

      {/* 전체 대화 + 입력 */}
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
                    {textOf(m.body)}
                  </span>
                </li>
              ))}
            </ul>
            {err && <p role="alert" className="mb-1 text-xs text-red-soft">{err}</p>}
            <form onSubmit={submit} className="flex gap-2">
              <input className="field !min-h-[44px] flex-1 !py-2 text-sm" maxLength={80} placeholder="메시지 (최대 80자)" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" aria-label="채팅 입력" autoFocus />
              <button className="candy candy-sm !min-h-[44px]" disabled={busy || text.trim().length === 0}>전송</button>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
