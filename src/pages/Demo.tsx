import { useState } from 'react'
import MatchStage, { type StageCard } from '../components/MatchStage'

/** 개발 서버 전용(/demo): Supabase 없이 3D 연출(뒷면·공개 표식·이마 카드·쇼다운 뒤집기)을 확인한다. */
export default function Demo() {
  const [mode, setMode] = useState<'A' | 'B'>('B')
  const [reveal, setReveal] = useState(false)
  const [key, setKey] = useState(0)
  const [pot, setPot] = useState(6)
  const opp: StageCard[] = reveal ? [{ value: 7 }, { value: 7 }] : mode === 'A' ? [{ value: 7, tag: '공개' }, { value: null }] : [{ value: 7 }, { value: 7 }]
  const me: StageCard[] = reveal ? [{ value: 3 }, { value: 10 }] : mode === 'A' ? [{ value: 3, tag: '공개' }, { value: 10 }] : [{ value: null, forehead: true }, { value: null, forehead: true }]
  return (
    <main className="page py-4">
      <div className="mb-3 flex flex-wrap gap-2">
        <button className="candy candy-sm" onClick={() => { setMode(mode === 'A' ? 'B' : 'A'); setReveal(false); setKey((k) => k + 1) }}>{mode} 모드</button>
        <button className="candy candy-sm candy-blue" onClick={() => setReveal((r) => !r)}>{reveal ? '다시 가리기' : '쇼다운'}</button>
        <button className="candy candy-sm candy-dark" onClick={() => setKey((k) => k + 1)}>새 판</button>
        <button className="candy candy-sm candy-gold" onClick={() => setPot((p) => (p + 3) % 20)}>판돈 {pot}</button>
      </div>
      <div className="h-[60dvh] min-h-[360px]">
        <MatchStage opp={opp} me={me} pot={pot} handKey={`d${key}`} winner={reveal ? 'opp' : null} />
      </div>
    </main>
  )
}
