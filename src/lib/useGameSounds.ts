import { useEffect, useRef } from 'react'
import type { MatchState, SpectateState } from './api'
import { playSfx } from './sound'

/**
 * 상태 변화에 맞춰 효과음을 낸다 (처음 불러온 상태에서는 소리를 내지 않는다).
 * mySeat 가 null 이면 관전자: 승패 소리 대신 중립 효과음만 낸다.
 */
export function useGameSounds(state: MatchState | SpectateState | null, mySeat: number | null) {
  const prev = useRef<{ handId: string | null; actions: number; turn: number | null; finished: boolean; shuffleKey: string } | null>(null)

  useEffect(() => {
    if (!state) return
    const h = state.hand
    const shuffleKey = state.pile.hard ? `${state.pile.shuffle_no}` : ''
    const cur = {
      handId: h?.id ?? null,
      actions: state.actions.length,
      turn: h?.status === 'betting' ? h.turn_seat : null,
      finished: h?.status === 'finished',
      shuffleKey,
    }
    const p = prev.current
    prev.current = cur
    if (!p) return

    if (cur.handId !== p.handId) {
      if (state.pile.hard && state.pile.fresh && cur.shuffleKey !== p.shuffleKey) playSfx('shuffle')
      else playSfx('deal')
      return
    }
    // 같은 판 안에서 새로 생긴 행동
    for (const a of state.actions.slice(p.actions)) {
      if (a.action === 'bet' || a.action === 'raise' || a.action === 'call') playSfx('chip')
      else if (a.action === 'die') playSfx('die')
      else playSfx('check')
    }
    if (cur.finished && !p.finished && h?.result) {
      if (mySeat === null) playSfx('win')
      else playSfx(h.result.winners.some((w) => w.seat === mySeat) ? 'win' : 'lose')
      return
    }
    if (mySeat !== null && cur.turn === mySeat && p.turn !== mySeat) playSfx('turn')
  }, [state, mySeat])
}
