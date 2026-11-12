import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

export function Coin({ className = '' }: { className?: string }) {
  return <span className={`coin ${className}`} aria-hidden />
}

export function Chips({ n, className = '' }: { n: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 tabular-nums ${className}`}>
      <Coin />
      <b className="font-normal">{n}</b>
    </span>
  )
}

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <Link to="/" className="inline-flex items-center gap-2 no-underline" aria-label="블러피 홈">
      <span className="relative inline-block h-8 w-9">
        <span className="absolute left-0 top-1 h-7 w-5 -rotate-12 rounded-lg bg-red shadow-[0_3px_0_rgb(var(--c-red-deep))]" />
        <span className="absolute left-3 top-1 h-7 w-5 rotate-12 rounded-lg bg-blue shadow-[0_3px_0_rgb(var(--c-blue-deep))]" />
      </span>
      <span className={`${small ? 'text-xl' : 'text-3xl'} text-ink`}>블러피</span>
    </Link>
  )
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    ref.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 px-4 pb-4 pt-10 sm:items-center" onClick={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="jelly-panel animate-pop max-h-[88dvh] w-full max-w-md overflow-y-auto p-5 outline-none"
      >
        <h2 className="mb-3 text-2xl">{title}</h2>
        {children}
      </div>
    </div>
  )
}

/** 30초 안에 읽을 수 있는 분량의 규칙 안내 */
export function RulesBody() {
  return (
    <ul className="space-y-2.5 text-[1.02rem] leading-snug">
      <li><span className="tag mr-1.5">테이블</span>2~5명이 한 테이블! 방장이 마음대로 시작할 수 있어요. (5명이면 자동 시작)</li>
      <li><span className="tag tag-red mr-1.5">족보</span>카드 1~10을 2장씩 받아요. 페어(같은 숫자) &gt; 합이 큰 쪽. 페어끼리는 큰 숫자가 이겨요. 승부에 남은 사람 중 최고 족보가 판돈을 가져가요.</li>
      <li><span className="tag mr-1.5">베팅</span>판마다 기본 판돈(앤티)을 걸고 시작! 앤티는 판 번호만큼이에요(1판 1칩 … 10판 10칩). 계속 다이만 해도 칩이 줄어요. 체크 · 베팅/레이즈(1~3칩, 판당 3번) · 콜 · 다이(포기). 한 번에 20초.</li>
      <li><span className="tag tag-red mr-1.5">매치</span>시작 칩 100개, 최대 10판. 칩이 바닥나면 탈락, 한 명만 남으면 끝. 최종 칩 − 100이 내 수익이에요.</li>
      <li>
        <span className="tag mr-1.5">A 모드</span>내 카드 2장 + 각 상대의 공개 카드 1장이 보여요.
        <br />
        <span className="tag tag-red mr-1.5">B 모드</span>모든 상대의 카드 2장이 보여요. 내 카드만 몰라요!
      </li>
      <li className="text-sm text-muted">한 판이 끝나면 그 판에 참여한 모두의 패가 공개돼요. 칩은 가상이며 무료예요. 현금·경품과 무관해요.</li>
    </ul>
  )
}

const RULES_SEEN = 'bluffy_rules_seen'

/** 첫 방문 시 자동으로 열리는 규칙 안내 */
export function RulesModal({ forceOpen, onClose }: { forceOpen?: boolean; onClose?: () => void }) {
  const [auto, setAuto] = useState(false)
  useEffect(() => {
    try {
      if (!localStorage.getItem(RULES_SEEN)) setAuto(true)
    } catch {
      /* localStorage 를 못 쓰는 환경에서는 자동 안내를 건너뜀 */
    }
  }, [])
  const open = Boolean(forceOpen) || auto
  const close = () => {
    try { localStorage.setItem(RULES_SEEN, '1') } catch { /* noop */ }
    setAuto(false)
    onClose?.()
  }
  return (
    <Modal open={open} onClose={close} title="30초 규칙 안내">
      <RulesBody />
      <button className="candy candy-blue mt-5 w-full" onClick={close}>알겠어요!</button>
    </Modal>
  )
}

export function CopyButton({ text, label, className = '' }: { text: string; label: string; className?: string }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setDone(true)
    setTimeout(() => setDone(false), 1800)
  }
  return (
    <button className={`candy candy-sm ${done ? 'candy-blue' : 'candy-dark'} ${className}`} onClick={copy}>
      {done ? '복사했어요!' : label}
    </button>
  )
}

export function Spinner({ label = '불러오는 중...' }: { label?: string }) {
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-4" role="status">
      <div className="flex gap-2">
        {[0, 1, 2].map((i) => (
          <span key={i} className="coin animate-bounceY !h-5 !w-5" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </div>
      <p className="text-muted">{label}</p>
    </div>
  )
}

/** 연결 실패(네트워크 끊김, Supabase 무료 프로젝트 일시정지 등)를 위한 친절한 에러 화면 */
export function ErrorScreen({ onRetry, title, message }: { onRetry?: () => void; title?: string; message?: string }) {
  return (
    <div className="page flex min-h-[80dvh] flex-col items-center justify-center text-center">
      <div className="jelly-panel animate-pop w-full p-6">
        <div className="mx-auto mb-4 flex h-20 w-20 animate-wobble items-center justify-center rounded-[40%_60%_55%_45%] bg-red text-5xl shadow-[0_6px_0_rgb(var(--c-red-deep))]">
          ?!
        </div>
        <h1 className="mb-2 text-2xl">{title ?? '서버와 연결이 안 돼요'}</h1>
        <p className="mb-5 leading-relaxed text-muted">
          {message ?? (
            <>
              인터넷 연결을 확인하고 잠시 후 다시 시도해주세요.
              <br />
              무료 서버는 한동안 쓰지 않으면 <b className="text-ink">일시정지</b>될 수 있어요. 운영자에게 알려주세요.
            </>
          )}
        </p>
        <div className="flex flex-col gap-3">
          {onRetry && <button className="candy" onClick={onRetry}>다시 시도</button>}
          <Link to="/" className="candy candy-dark no-underline">처음으로</Link>
        </div>
      </div>
    </div>
  )
}

export function ConfigScreen() {
  return (
    <ErrorScreen
      title="설정이 필요해요"
      message="VITE_SUPABASE_URL 과 VITE_SUPABASE_ANON_KEY 환경변수를 설정해주세요. (README 의 'Supabase 설정' 참고)"
    />
  )
}
