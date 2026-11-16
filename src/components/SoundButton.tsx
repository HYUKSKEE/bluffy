import { useEffect, useRef, useState } from 'react'
import { playSfx, setSound, unlockAudio, useSoundSettings } from '../lib/sound'

/** 소리 설정 버튼: 효과음 / 배경음악 켜기·끄기 + 음량. 설정은 이 브라우저에 저장된다. */
export function SoundButton() {
  const s = useSoundSettings()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const off = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', off)
    return () => document.removeEventListener('pointerdown', off)
  }, [open])

  const muted = (!s.sfx && !s.music) || s.volume === 0
  return (
    <div className="relative" ref={box}>
      <button
        className="candy candy-dark candy-sm !min-h-[40px] !px-3 !py-2 text-sm"
        aria-label="소리 설정"
        aria-expanded={open}
        onClick={() => {
          unlockAudio()
          setOpen((v) => !v)
        }}
      >
        {muted ? '🔇' : '🔊'}
      </button>
      {open && (
        <div role="dialog" aria-label="소리 설정" className="jelly-panel animate-pop absolute right-0 top-12 z-40 w-60 space-y-3 p-4 text-sm">
          <label className="flex items-center justify-between gap-3">
            <span>효과음</span>
            <input type="checkbox" className="h-5 w-5 accent-[#3da5ff]" checked={s.sfx} onChange={(e) => { setSound({ sfx: e.target.checked }); if (e.target.checked) setTimeout(() => playSfx('chip'), 50) }} />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span>배경음악</span>
            <input type="checkbox" className="h-5 w-5 accent-[#3da5ff]" checked={s.music} onChange={(e) => setSound({ music: e.target.checked })} />
          </label>
          <label className="block">
            <span className="mb-1 block text-muted">음량 {Math.round(s.volume * 100)}%</span>
            <input type="range" min={0} max={100} value={Math.round(s.volume * 100)} className="w-full accent-[#3da5ff]" onChange={(e) => setSound({ volume: Number(e.target.value) / 100 })} />
          </label>
        </div>
      )}
    </div>
  )
}
