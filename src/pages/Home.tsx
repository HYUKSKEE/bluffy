import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Logo, RulesBody, RulesModal } from '../components/ui'

export default function Home() {
  const [rules, setRules] = useState(false)
  return (
    <main className="page flex min-h-[100dvh] flex-col py-6">
      <RulesModal />
      <header className="flex items-center justify-between">
        <Logo />
        <button className="candy candy-dark candy-sm" onClick={() => setRules(true)}>규칙</button>
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
        <button className="mt-5 text-muted underline underline-offset-4" onClick={() => setRules(true)}>30초 규칙 보기</button>
      </section>

      <footer className="pb-safe text-center text-xs leading-relaxed text-muted">
        칩은 가상의 무료 포인트예요. 현금·경품·충전·환전·거래 기능은 없어요.
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
