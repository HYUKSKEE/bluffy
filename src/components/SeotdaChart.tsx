import { useState } from 'react'
import { Modal } from './ui'

const img = (id: number) => `/hwatu/${String(id).padStart(2, '0')}.png`

/** 족보표: [이름, 예시 카드 id 2장, 설명] — 높은 순 */
const ROWS: { group: string; items: { name: string; cards: [number, number]; note: string; tone?: 'gold' | 'red' | 'blue' }[] }[] = [
  {
    group: '광땡',
    items: [
      { name: '38광땡', cards: [5, 15], note: '3월 광 + 8월 광 · 최강', tone: 'gold' },
      { name: '18광땡', cards: [1, 15], note: '1월 광 + 8월 광', tone: 'gold' },
      { name: '13광땡', cards: [1, 5], note: '1월 광 + 3월 광 (18광땡과 같은 순위)', tone: 'gold' },
    ],
  },
  {
    group: '땡 (같은 월 두 장)',
    items: [
      { name: '장땡', cards: [19, 20], note: '10땡 · 땡 중 최강', tone: 'red' },
      { name: '9땡 … 1땡', cards: [17, 18], note: '숫자가 큰 땡이 이겨요 (예: 9월 두 장)', tone: 'red' },
    ],
  },
  {
    group: '특수 패 (월 조합)',
    items: [
      { name: '알리', cards: [1, 3], note: '1월 + 2월' },
      { name: '독사', cards: [1, 7], note: '1월 + 4월' },
      { name: '구삥', cards: [1, 17], note: '1월 + 9월' },
      { name: '장삥', cards: [1, 19], note: '1월 + 10월' },
      { name: '장사', cards: [7, 19], note: '4월 + 10월' },
      { name: '세륙', cards: [7, 11], note: '4월 + 6월' },
    ],
  },
  {
    group: '끗 (두 월의 합의 일의 자리)',
    items: [
      { name: '갑오 (9끗)', cards: [3, 13], note: '2월 + 7월 = 9 · 끗 중 최강', tone: 'blue' },
      { name: '8끗 … 1끗', cards: [17, 13], note: '예: 9월 + 7월 = 16 → 6끗', tone: 'blue' },
      { name: '망통 (0끗)', cards: [3, 15], note: '합이 10 → 0끗 · 최하', tone: 'blue' },
    ],
  },
]

const SPECIAL = [
  { name: '암행어사', cards: [7, 13] as [number, number], note: '4월 열끗 + 7월 열끗', beats: '18광땡·13광땡을 이겨요 (38광땡에는 져요). 상대에 18·13광땡이 없으면 그냥 1끗.' },
  { name: '땡잡이', cards: [5, 13] as [number, number], note: '3월 광 + 7월 열끗', beats: '1~9땡을 이겨요 (장땡·광땡에는 져요). 상대에 땡이 없으면 그냥 망통.' },
]

const TONE = { gold: 'text-gold', red: 'text-red-soft', blue: 'text-blue-soft' } as const

function Pair({ cards }: { cards: [number, number] }) {
  return (
    <span className="flex flex-none gap-0.5" aria-hidden>
      {cards.map((c, i) => (
        <img key={i} src={img(c)} alt="" loading="lazy" className="h-12 w-auto rounded-[3px] bg-white shadow" />
      ))}
    </span>
  )
}

/** 섯다 족보표 (높은 순). 카드 그림은 예시이며, 같은 족보는 월 조합만 맞으면 어떤 카드든 같습니다. */
export function SeotdaChartModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="섯다 족보표">
      <p className="mb-3 text-xs text-muted">위에 있을수록 강해요. 그림은 예시예요.</p>
      <div className="space-y-4">
        {ROWS.map((g) => (
          <section key={g.group}>
            <h3 className="mb-1.5 text-sm text-muted">{g.group}</h3>
            <ul className="space-y-1.5">
              {g.items.map((it) => (
                <li key={it.name} className="flex items-center gap-3 rounded-2xl bg-surface/70 px-3 py-1.5">
                  <Pair cards={it.cards} />
                  <span className="min-w-0 text-left">
                    <b className={`block font-normal ${it.tone ? TONE[it.tone] : ''}`}>{it.name}</b>
                    <span className="block text-xs text-muted">{it.note}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <section>
          <h3 className="mb-1.5 text-sm text-muted">특수 족보 (상대 패에 따라 힘이 생겨요)</h3>
          <ul className="space-y-1.5">
            {SPECIAL.map((it) => (
              <li key={it.name} className="flex items-center gap-3 rounded-2xl bg-red/15 px-3 py-1.5">
                <Pair cards={it.cards} />
                <span className="min-w-0 text-left">
                  <b className="block font-normal text-red-soft">{it.name}</b>
                  <span className="block text-xs text-muted">{it.note}</span>
                  <span className="block text-xs">{it.beats}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <button className="candy candy-blue mt-5 w-full" onClick={onClose}>닫기</button>
    </Modal>
  )
}

/** 족보표를 여는 작은 버튼 (섯다 방에서만 보여준다) */
export function SeotdaChartButton({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className={`tag tag-red cursor-pointer ${className}`} onClick={() => setOpen(true)} aria-label="섯다 족보표 열기">
        📖 섯다 족보
      </button>
      <SeotdaChartModal open={open} onClose={() => setOpen(false)} />
    </>
  )
}
