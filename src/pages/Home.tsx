import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type OpenRoom } from '../lib/api'
import { CreditsModal, Logo, RulesBody, RulesModal } from '../components/ui'
import { SoundButton } from '../components/SoundButton'

export default function Home() {
  const [rules, setRules] = useState(false)
  const [rooms, setRooms] = useState<OpenRoom[]>([])
  const [credits, setCredits] = useState(false)

  // 열려 있는 공개 방 목록 (실패해도 홈은 그대로 쓴다)
  useEffect(() => {
    let alive = true
    const load = () => api.listOpenRooms().then((r) => alive && setRooms(r)).catch(() => undefined)
    void load()
    const t = setInterval(load, 10000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  return (
    <main className="page flex min-h-[100dvh] flex-col py-6">
      <RulesModal />
      <header className="flex items-center justify-between">
        <Logo />
        <div className="flex gap-1.5">
          <SoundButton />
          <button className="candy candy-dark candy-sm" onClick={() => setRules(true)}>규칙</button>
        </div>
      </header>

      <section className="flex flex-1 flex-col items-center justify-center py-8 text-center">
        <div className="relative mb-8 h-44 w-56" aria-hidden>
          <div className="animate-bounceY absolute left-2 top-4 h-36 w-24 -rotate-12 rounded-[26px] bg-gradient-to-b from-red to-red-deep shadow-[0_10px_0_rgb(var(--c-red-deep)),0_20px_30px_rgb(0_0_0/.5)]">
            <div className="m-2 flex h-[calc(100%-16px)] items-center justify-center rounded-[20px] bg-red-soft text-6xl text-red-deep">9</div>
          </div>
          <div className="animate-bounceY absolute right-2 top-2 h-36 w-24 rotate-12 rounded-[26px] bg-gradient-to-b from-blue to-blue-deep shadow-[0_10px_0_rgb(var(--c-blue-deep)),0_20px_30px_rgb(0_0_0/.5)]" style={{ animationDelay: '.4s' }}>
            <div className="m-2 flex h-[calc(100%-16px)] items-center justify-center rounded-[20px] bg-blue-soft text-7xl text-blue-deep">?</div>
          </div>
        </div>

        <h1 className="mb-3 text-4xl leading-tight">
          링크 하나로 시작하는
          <br />
          <span className="text-red">2~5인</span> <span className="text-blue">카드 베팅</span> 대결
        </h1>
        <p className="mb-8 max-w-xs leading-relaxed text-muted">
          방을 만들고 링크를 공유하면 들어온 사람끼리 한 테이블에! 방장이 시작하면 눈치 싸움 시작, 방 랭킹 1위를 노려보세요.
        </p>
        <Link to="/create" className="candy w-full max-w-xs text-xl no-underline">방 만들기</Link>
        <Link to="/practice" className="candy candy-dark mt-3 w-full max-w-xs no-underline">🤖 혼자 연습하기 <span className="text-xs text-muted">(점수 반영 없음)</span></Link>
        <button className="mt-5 text-muted underline underline-offset-4" onClick={() => setRules(true)}>30초 규칙 보기</button>
      </section>

      {rooms.length > 0 && (
        <section className="mb-6" aria-label="열려 있는 방">
          <h2 className="mb-2 text-xl">열려 있는 방 <span className="text-sm text-muted">({rooms.length})</span></h2>
          <ul className="space-y-2">
            {rooms.map((r) => (
              <li key={r.id}>
                <Link to={`/r/${r.id}`} className="jelly-panel flex items-center justify-between gap-3 !rounded-2xl px-4 py-3 no-underline">
                  <span className="min-w-0">
                    <span className="block truncate">{r.title}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted">
                      <span className={`tag ${r.mode === 'B' ? 'tag-red' : ''}`}>{r.mode} 모드</span>
                      {r.hard && <span className="tag tag-red">고난이도</span>}
                      {r.seotda && <span className="tag tag-red">섯다</span>}
                      {r.participants}명 · 대결 {r.active_matches}건{r.waiting_tables > 0 ? ` · 대기 ${r.waiting_tables}` : ''}
                    </span>
                  </span>
                  <span className="candy candy-sm flex-none !min-h-[36px] !px-3">입장</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="pb-safe text-center text-xs leading-relaxed text-muted">
        칩은 가상의 무료 포인트예요. 현금·경품·충전·환전·거래 기능은 없어요.
        <br />
        <button className="mt-1 underline underline-offset-4" onClick={() => setCredits(true)}>이미지 저작자 표시</button>
        <CreditsModal open={credits} onClose={() => setCredits(false)} />
      </footer>

      {rules && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 px-4 pb-4" onClick={() => setRules(false)}>
          <div className="jelly-panel animate-pop w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 text-2xl">30초 규칙 안내</h2>
            <RulesBody />
            <button className="candy candy-blue mt-5 w-full" onClick={() => setRules(false)}>닫기</button>
          </div>
        </div>
      )}
    </main>
  )
}
