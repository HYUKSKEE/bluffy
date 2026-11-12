import { ensureAuth, supabase } from './supabase'

// ───────────── 타입 ─────────────
export type Mode = 'A' | 'B'

export interface PlayerSelf {
  id: string
  nickname: string
  status: 'idle' | 'queued' | 'playing'
  total_profit: number
  matches_played: number
  matches_won: number
  final_rank: number | null
}

export interface RankRow {
  id: string
  nickname: string
  total_profit: number
  matches_played: number
  matches_won: number
  joined_at: string
  rank: number
  status: 'idle' | 'queued' | 'playing'
}

export interface RoomView {
  room: { id: string; title: string; mode: Mode; status: 'open' | 'closed'; created_at: string; closed_at: string | null }
  participants: number
  active_matches: number
  ranking: RankRow[]
}

export interface MatchState {
  server_now: string
  seat: 1 | 2
  match: {
    id: string
    room_id: string
    room_status: 'open' | 'closed'
    mode: Mode
    status: 'playing' | 'finished' | 'void'
    hand_no: number
    max_hands: number
    chips1: number
    chips2: number
    carry: number
    player1: { id: string; nickname: string }
    player2: { id: string; nickname: string }
    winner_id: string | null
    end_reason: 'bust' | 'complete' | 'forfeit' | 'void' | null
    profit1: number | null
    profit2: number | null
    next_hand_at: string | null
  }
  hand: null | {
    id: string
    hand_no: number
    status: 'betting' | 'finished' | 'void'
    pot: number
    current_bet: number
    committed1: number
    committed2: number
    lead_player_id: string
    turn_player_id: string | null
    raise_count: number
    checks: number
    turn_deadline: string | null
    result: null | { winner_id: string | null; reason: 'showdown' | 'tie' | 'fold' | 'forfeit'; pot: number; carry: number }
  }
  actions: { id: number; player_id: string; action: 'check' | 'bet' | 'raise' | 'call' | 'die'; amount: number; auto: boolean; created_at: string }[]
}

/** 못 보는 카드는 null (서버가 모드·요청자에 따라 결정) */
export interface VisibleHand {
  hand_id: string
  hand_no: number
  mode: Mode
  seat: 1 | 2
  revealed: boolean
  me: (number | null)[]
  opp: (number | null)[]
  me_open: 1 | 2 | null
  opp_open: 1 | 2 | null
}

// ───────────── 에러 ─────────────
export class GameError extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}
/** 네트워크 끊김 / Supabase 무료 프로젝트 일시정지 등 */
export class ConnectionError extends Error {}

const MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: '로그인 정보가 없어요. 새로고침 해주세요.',
  BAD_TITLE: '방 제목은 1~40자로 적어주세요.',
  BAD_MODE: '모드를 선택해주세요.',
  ROOM_NOT_FOUND: '존재하지 않는 방이에요. 링크를 확인해주세요.',
  ROOM_CLOSED: '이미 종료된 방이에요.',
  ROOM_FULL: '방이 가득 찼어요.',
  BAD_NICKNAME: '닉네임은 1~12자로 적어주세요.',
  NICKNAME_TAKEN: '이미 사용 중인 닉네임이에요.',
  NOT_JOINED: '먼저 닉네임을 등록해주세요.',
  NOT_A_PLAYER: '이 매치의 참가자가 아니에요.',
  MATCH_NOT_FOUND: '매치를 찾을 수 없어요.',
  NOT_YOUR_TURN: '내 차례가 아니에요.',
  TURN_EXPIRED: '시간이 지났어요.',
  HAND_NOT_ACTIVE: '이미 끝난 판이에요.',
  CANNOT_CHECK: '올린 금액이 있어서 체크할 수 없어요.',
  NOTHING_TO_CALL: '맞출 금액이 없어요.',
  WRONG_ACTION: '지금은 할 수 없는 행동이에요.',
  RAISE_LIMIT: '이번 판 레이즈 횟수를 모두 썼어요.',
  BAD_AMOUNT: '걸 수 없는 금액이에요.',
  FORBIDDEN: '관리 권한이 없어요. 관리 링크로 들어와주세요.',
}

const CODE_RE = new RegExp(`(${Object.keys(MESSAGES).join('|')}|UNKNOWN_ACTION|HAND_NOT_FOUND)`)

function isNetworkish(err: { message?: string; status?: number; code?: string } | null): boolean {
  if (!err) return false
  const msg = (err.message ?? '').toLowerCase()
  return (
    msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('network request failed') ||
    msg.includes('load failed') || msg.includes('timeout') || msg.includes('paused') ||
    (typeof err.status === 'number' && (err.status === 0 || err.status >= 500))
  )
}

function toError(err: { message?: string; status?: number; code?: string }): Error {
  const m = CODE_RE.exec(err.message ?? '')
  if (m) return new GameError(m[1], MESSAGES[m[1]] ?? m[1])
  if (isNetworkish(err)) return new ConnectionError(err.message)
  return new Error(err.message ?? '알 수 없는 오류')
}

export const isConnectionError = (e: unknown) => e instanceof ConnectionError

export function friendly(e: unknown): string {
  if (e instanceof GameError) return e.message
  if (e instanceof ConnectionError) return '서버에 연결할 수 없어요.'
  return e instanceof Error ? e.message : '알 수 없는 오류가 발생했어요.'
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  try {
    await ensureAuth()
  } catch (e) {
    throw isNetworkish(e as any) || (e as any)?.name === 'AuthRetryableFetchError' ? new ConnectionError((e as Error).message) : e
  }
  let res
  try {
    res = await supabase.rpc(fn, args)
  } catch (e) {
    throw new ConnectionError((e as Error).message)
  }
  if (res.error) throw toError(res.error)
  return res.data as T
}

// ───────────── RPC 래퍼 ─────────────
export const api = {
  createRoom: (title: string, mode: Mode) =>
    rpc<{ room_id: string; admin_token: string }>('card_create_room', { p_title: title, p_mode: mode }),
  getRoomView: (roomId: string) => rpc<RoomView>('card_get_room_view', { p_room_id: roomId }),
  joinRoom: (roomId: string, nickname: string) => rpc<PlayerSelf>('card_join_room', { p_room_id: roomId, p_nickname: nickname }),
  myStatus: (roomId: string) => rpc<{ player: PlayerSelf | null; match_id: string | null }>('card_my_status', { p_room_id: roomId }),
  heartbeat: (roomId: string) => rpc<void>('card_heartbeat', { p_room_id: roomId }),
  queueMatch: (roomId: string) => rpc<{ status: 'queued' | 'matched'; match_id?: string }>('card_queue_match', { p_room_id: roomId }),
  cancelQueue: (roomId: string) => rpc<void>('card_cancel_queue', { p_room_id: roomId }),
  getMatchState: (matchId: string) => rpc<MatchState>('card_get_match_state', { p_match_id: matchId }),
  getVisibleHand: (matchId: string, handNo?: number) =>
    rpc<VisibleHand | null>('card_get_visible_hand', { p_match_id: matchId, p_hand_no: handNo ?? null }),
  act: (handId: string, action: 'check' | 'bet' | 'raise' | 'call' | 'die', amount = 0) =>
    rpc<{ ok: boolean }>('card_act', { p_hand_id: handId, p_action: action, p_amount: amount }),
  timeoutCheck: (handId: string) => rpc<{ result: string }>('card_timeout_check', { p_hand_id: handId }),
  advanceMatch: (matchId: string) => rpc<{ result: string }>('card_advance_match', { p_match_id: matchId }),
  leaveMatch: (matchId: string) => rpc<void>('card_leave_match', { p_match_id: matchId }),
  verifyAdmin: (roomId: string, token: string) => rpc<boolean>('card_verify_admin', { p_room_id: roomId, p_admin_token: token }),
  closeRoom: (roomId: string, token: string) => rpc<{ ok: boolean }>('card_close_room', { p_room_id: roomId, p_admin_token: token }),
}

// ───────────── Realtime (신호 전용) ─────────────
/**
 * DB 가 보내는 broadcast 신호("바뀌었다")만 받는다. 값은 실려 오지 않으므로 받으면 RPC 로 다시 조회한다.
 * 연결이 불안정할 때를 대비해 호출하는 쪽에서 폴링도 함께 쓴다.
 */
export function subscribeSignal(topic: string, onSignal: () => void): () => void {
  const ch = supabase
    .channel(topic)
    .on('broadcast', { event: 'changed' }, () => onSignal())
    .subscribe()
  return () => {
    void supabase.removeChannel(ch)
  }
}

// ───────────── 관리 토큰(브라우저 보관) ─────────────
const adminKey = (roomId: string) => `bluffy_admin_${roomId}`
export const saveAdminToken = (roomId: string, token: string) => {
  try { localStorage.setItem(adminKey(roomId), token) } catch { /* 저장 불가 환경 */ }
}
export const loadAdminToken = (roomId: string): string | null => {
  try { return localStorage.getItem(adminKey(roomId)) } catch { return null }
}
