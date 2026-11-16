import { useCallback, useEffect, useRef, useState } from 'react'
import { playSfx } from './sound'
import { api, emoteOf, subscribeSignal, type ChatMessage, type EmoteKey, type MatchState, type PlayerSelf, type RoomView, type SpectateState, type TableInfo, type VisibleHand } from './api'

/** 초 단위 이하로 갱신되는 현재 시각(ms). 서버 시계 보정은 호출하는 쪽에서 offset 을 더한다. */
export function useTicker(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/** 같은 함수를 동시에 한 번만 돌리고, 실행 중에 다시 요청되면 끝난 뒤 한 번 더 돌린다. */
function useCoalesced(fn: () => Promise<void>) {
  const busy = useRef(false)
  const again = useRef(false)
  const fnRef = useRef(fn)
  fnRef.current = fn
  return useCallback(async () => {
    if (busy.current) {
      again.current = true
      return
    }
    busy.current = true
    try {
      do {
        again.current = false
        await fnRef.current()
      } while (again.current)
    } finally {
      busy.current = false
    }
  }, [])
}

// ───────────── 방 (랭킹 + 내 상태) ─────────────
export function useRoom(roomId: string) {
  const [view, setView] = useState<RoomView | null>(null)
  const [player, setPlayer] = useState<PlayerSelf | null | undefined>(undefined) // undefined = 아직 모름
  const [matchId, setMatchId] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)

  const refresh = useCoalesced(async () => {
    try {
      const [v, me] = await Promise.all([api.getRoomView(roomId), api.myStatus(roomId)])
      setView(v)
      setPlayer(me.player)
      setMatchId(me.match_id)
      setError(null)
    } catch (e) {
      setError(e)
    }
  })

  useEffect(() => {
    void refresh()
    const off = subscribeSignal(`card_room:${roomId}`, () => void refresh())
    const poll = setInterval(() => void refresh(), 5000) // Realtime 이 끊겨도 동작하도록 하는 보조 폴링
    const onVis = () => document.visibilityState === 'visible' && void refresh()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      off()
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [roomId, refresh])

  // 연결 유지 신호: 대기/대결 중 응답 없음(60초) 판정에 쓰인다.
  useEffect(() => {
    if (!player) return
    const hb = () => void api.heartbeat(roomId).catch(() => undefined)
    hb()
    const id = setInterval(hb, 10000)
    return () => clearInterval(id)
  }, [roomId, player?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return { view, player, matchId, error, refresh, setPlayer, setMatchId }
}

// ───────────── 매치 ─────────────
export function useMatch(matchId: string) {
  const [state, setState] = useState<MatchState | null>(null)
  const [cards, setCards] = useState<VisibleHand | null>(null)
  const [error, setError] = useState<unknown>(null)
  const offset = useRef(0) // 서버 시각 - 내 시각 (ms)

  const refresh = useCoalesced(async () => {
    try {
      // 상태와 카드는 별도 RPC 이므로 중간에 판이 바뀌면(hand_id 불일치) 다시 조회한다.
      for (let i = 0; i < 3; i++) {
        const st = await api.getMatchState(matchId)
        offset.current = new Date(st.server_now).getTime() - Date.now()
        const vh = st.hand ? await api.getVisibleHand(matchId) : null
        if (vh && st.hand && vh.hand_id !== st.hand.id) continue
        setState(st)
        setCards(vh)
        setError(null)
        return
      }
    } catch (e) {
      setError(e)
    }
  })

  useEffect(() => {
    void refresh()
    const off = subscribeSignal(`card_match:${matchId}`, () => void refresh())
    const poll = setInterval(() => void refresh(), 3000)
    const onVis = () => document.visibilityState === 'visible' && void refresh()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      off()
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [matchId, refresh])

  const serverNow = useCallback(() => Date.now() + offset.current, [])

  // 타임아웃 / 다음 판 시작: 서버가 조건을 검증하므로 두 클라이언트가 호출해도 안전(멱등)하다.
  const lastCall = useRef(0)
  const now = useTicker(500)
  useEffect(() => {
    if (!state || state.match.status !== 'playing') return
    const t = Date.now()
    if (t - lastCall.current < 2500) return
    const sNow = t + offset.current
    const h = state.hand
    let call: Promise<unknown> | null = null
    if (h && h.status === 'betting' && h.turn_deadline && sNow > new Date(h.turn_deadline).getTime() + 1200) {
      call = api.timeoutCheck(h.id)
    } else if (h && h.status === 'finished' && state.match.next_hand_at && sNow >= new Date(state.match.next_hand_at).getTime()) {
      call = api.advanceMatch(state.match.id)
    }
    if (call) {
      lastCall.current = t
      void call.catch(() => undefined).finally(() => void refresh())
    }
  }, [now, state, refresh])

  return { state, cards, error, refresh, serverNow }
}

// ───────────── 관전 ─────────────
export function useSpectate(matchId: string) {
  const [state, setState] = useState<SpectateState | null>(null)
  const [error, setError] = useState<unknown>(null)
  const offset = useRef(0)

  const refresh = useCoalesced(async () => {
    try {
      const st = await api.spectateMatch(matchId)
      offset.current = new Date(st.server_now).getTime() - Date.now()
      setState(st)
      setError(null)
    } catch (e) {
      setError(e)
    }
  })

  useEffect(() => {
    void refresh()
    const off = subscribeSignal(`card_match:${matchId}`, () => void refresh())
    const poll = setInterval(() => void refresh(), 3000)
    const onVis = () => document.visibilityState === 'visible' && void refresh()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      off()
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [matchId, refresh])

  const serverNow = useCallback(() => Date.now() + offset.current, [])
  return { state, error, refresh, serverNow }
}

/** 로비의 테이블 목록 (대기 중 + 진행 중) */
export function useTables(roomId: string, enabled: boolean) {
  const [tables, setTables] = useState<TableInfo[]>([])
  const refresh = useCoalesced(async () => {
    try {
      setTables(await api.listTables(roomId))
    } catch {
      /* 목록은 부가 정보라 실패해도 로비는 계속 쓴다 */
    }
  })
  useEffect(() => {
    if (!enabled) return
    void refresh()
    const off = subscribeSignal(`card_room:${roomId}`, () => void refresh())
    const poll = setInterval(() => void refresh(), 5000)
    return () => {
      off()
      clearInterval(poll)
    }
  }, [roomId, enabled, refresh])
  return tables
}

// ───────────── 채팅 ─────────────
/** 내 채널(참가자 'table' / 관전자 'spectate')의 채팅. 새 메시지는 신호 + 폴링으로 가져온다. */
export function useChat(matchId: string, open: boolean) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [channel, setChannel] = useState<'table' | 'spectate' | null>(null)
  const [unread, setUnread] = useState(0)
  const [emote, setEmote] = useState<{ id: number; key: EmoteKey; nickname: string; mine: boolean } | null>(null)
  const lastId = useRef(0)
  const openRef = useRef(open)
  openRef.current = open
  const first = useRef(true)

  const refresh = useCoalesced(async () => {
    try {
      const r = await api.getChat(matchId, lastId.current)
      setChannel(r.channel)
      if (r.messages.length === 0) return
      lastId.current = r.messages[r.messages.length - 1].id
      setMessages((m) => [...m, ...r.messages].slice(-100))
      if (!first.current) {
        const fresh = r.messages.filter((x) => !x.mine)
        const emotes = r.messages.filter((x) => emoteOf(x.body))
        if (emotes.length > 0) {
          // 새로 온 이모지 중 마지막 것을 화면에 띄우고 소리를 낸다 (내가 보낸 것도 확인용으로 함께)
          const e = emotes[emotes.length - 1]
          const key = emoteOf(e.body)!
          setEmote({ id: e.id, key, nickname: e.nickname, mine: e.mine })
          if (!e.mine) playSfx(`emote_${key}` as const)
        } else if (fresh.length > 0) {
          playSfx('msg')
        }
        if (fresh.length > 0 && !openRef.current) setUnread((u) => u + fresh.length)
      }
    } catch {
      /* 채팅은 부가 기능이라 실패해도 게임은 계속된다 */
    } finally {
      first.current = false
    }
  })

  useEffect(() => {
    lastId.current = 0
    first.current = true
    setMessages([])
    setUnread(0)
    void refresh()
  }, [matchId, refresh])

  useEffect(() => {
    const id = setInterval(() => void refresh(), 4000)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => {
    if (!channel) return
    return subscribeSignal(`card_chat:${matchId}:${channel}`, () => void refresh())
  }, [matchId, channel, refresh])

  useEffect(() => {
    if (open) setUnread(0)
  }, [open])

  // 화면에 띄운 이모지는 잠깐 뒤에 사라진다
  useEffect(() => {
    if (!emote) return
    const t = setTimeout(() => setEmote(null), 2600)
    return () => clearTimeout(t)
  }, [emote])

  const sendEmote = useCallback(
    async (key: EmoteKey) => {
      await api.sendEmote(matchId, key)
      playSfx(`emote_${key}` as const) // 보낸 사람도 소리를 듣는다
      await refresh()
    },
    [matchId, refresh],
  )

  const send = useCallback(
    async (body: string) => {
      await api.sendChat(matchId, body)
      await refresh()
    },
    [matchId, refresh],
  )
  return { messages, channel, unread, send, sendEmote, emote }
}
