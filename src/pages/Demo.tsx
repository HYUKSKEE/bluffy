import { useState } from 'react'
import MatchStage, { type StageOpp, type StageProps } from '../components/MatchStage'

/** 개발 서버 전용(/demo): Supabase 없이 3D 연출(뒷면·공개 표식·이마 카드·쇼다운 뒤집기)을 확인한다. */
export default function Demo() {
  const [mode, setMode] = useState<'A' | 'B'>('B')
  const [n, setN] = useState(4) // 상대 수 1~4
  const [reveal, setReveal] = useState(false)
  const [key, setKey] = useState(0)
  const [pot, setPot] = useState(6)
  const w = Number(new URLSearchParams(window.location.search).get('w')) || undefined // ?w=360 : 좁은 폰 폭 확인
  const names = ['철수', '영희', '민수', '지은']
  const opps: StageOpp[] = Array.from({ length: n }).map((_, i) => {
    const full = [7, 3 + i]
    const folded = i === 1 && n > 2
    return {
      id: `o${i}`,
      label: `${names[i]} · ${90 + i * 5}${folded ? ' 다이' : ''}`,
      cards: reveal && !folded ? [{ value: full[0] }, { value: full[1] }]
        : mode === 'A' ? [{ value: full[0], tag: '공개' }, { value: null }]
        : [{ value: full[0] }, { value: full[1] }],
      folded, out: false, active: !reveal && i === 0, win: reveal && i === 0,
    }
  })
  const me: StageProps['me'] = {
    cards: reveal ? [{ value: 3 }, { value: 10 }] : mode === 'A' ? [{ value: 3, tag: '공개' }, { value: 10 }] : [{ value: null, forehead: true }, { value: null, forehead: true }],
    win: false, folded: false, active: false, label: '나 · 100', out: false,
  }
  return (
    <main className="page py-4" style={w ? { maxWidth: w + 32 } : undefined}>
      <div className="mb-3 flex flex-wrap gap-2">
        <button className="candy candy-sm" onClick={() => { setMode(mode === 'A' ? 'B' : 'A'); setReveal(false); setKey((k) => k + 1) }}>{mode} 모드</button>
        <button className="candy candy-sm candy-blue" onClick={() => setReveal((r) => !r)}>{reveal ? '다시 가리기' : '쇼다운'}</button>
        <button className="candy candy-sm candy-dark" onClick={() => setKey((k) => k + 1)}>새 판</button>
        <button className="candy candy-sm candy-dark" onClick={() => { setN((x) => (x % 4) + 1); setKey((k) => k + 1) }}>상대 {n}명</button>
        <button className="candy candy-sm candy-gold" onClick={() => setPot((p) => (p + 3) % 20)}>판돈 {pot}</button>
      </div>
      <div className="h-[60dvh] min-h-[360px]">
        <MatchStage opps={opps} me={me} pot={pot} handKey={`d${key}`} />
      </div>
    </main>
  )
}
