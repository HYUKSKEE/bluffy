import { useSyncExternalStore } from 'react'

/**
 * 효과음 + 배경음악. 외부 파일 없이 WebAudio 로 직접 합성한다 (저작권/용량 걱정 없음).
 * 브라우저 정책상 사용자의 첫 터치 뒤에야 소리가 나므로, 첫 pointerdown 에서 오디오를 깨운다.
 */
export type Sfx = 'deal' | 'chip' | 'die' | 'check' | 'turn' | 'win' | 'lose' | 'shuffle' | 'msg' | 'emote_ugh' | 'emote_taunt' | 'emote_yes' | 'emote_sad'

export interface SoundSettings {
  sfx: boolean
  music: boolean
  volume: number // 0~1
}

const KEY = 'bluffy_sound'
const DEFAULTS: SoundSettings = { sfx: true, music: false, volume: 0.6 }

function load(): SoundSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const p = JSON.parse(raw)
      return { sfx: p.sfx !== false, music: p.music === true, volume: typeof p.volume === 'number' ? Math.min(1, Math.max(0, p.volume)) : DEFAULTS.volume }
    }
  } catch {
    /* 저장소를 못 쓰는 환경 */
  }
  return { ...DEFAULTS }
}

let settings: SoundSettings = load()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

let ctx: AudioContext | null = null
let master: GainNode | null = null
let musicBus: GainNode | null = null

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    try {
      ctx = new AC()
    } catch {
      return null
    }
    master = ctx.createGain()
    master.gain.value = settings.volume
    master.connect(ctx.destination)
    musicBus = ctx.createGain()
    musicBus.gain.value = 0.32
    musicBus.connect(master)
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  return ctx
}

/** 첫 터치/클릭에서 오디오를 깨우고, 음악이 켜져 있으면 시작한다 */
let unlocked = false
export function unlockAudio() {
  if (unlocked) return
  unlocked = true
  if (ensureCtx() && settings.music) startMusic()
}
if (typeof document !== 'undefined') {
  const once = () => {
    unlockAudio()
    document.removeEventListener('pointerdown', once)
    document.removeEventListener('keydown', once)
  }
  document.addEventListener('pointerdown', once)
  document.addEventListener('keydown', once)
}

// ───────────── 효과음 ─────────────
function tone(c: AudioContext, o: { f: number; t?: number; d: number; type?: OscillatorType; g?: number; slide?: number }) {
  const t0 = c.currentTime + (o.t ?? 0)
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = o.type ?? 'sine'
  osc.frequency.setValueAtTime(o.f, t0)
  if (o.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, o.f * o.slide), t0 + o.d)
  const peak = o.g ?? 0.25
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.d)
  osc.connect(g).connect(master!)
  osc.start(t0)
  osc.stop(t0 + o.d + 0.05)
}

function noise(c: AudioContext, o: { t?: number; d: number; freq: number; g?: number }) {
  const t0 = c.currentTime + (o.t ?? 0)
  const len = Math.max(1, Math.floor(c.sampleRate * o.d))
  const buf = c.createBuffer(1, len, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len)
  const src = c.createBufferSource()
  src.buffer = buf
  const f = c.createBiquadFilter()
  f.type = 'bandpass'
  f.frequency.value = o.freq
  f.Q.value = 0.9
  const g = c.createGain()
  g.gain.value = o.g ?? 0.3
  src.connect(f).connect(g).connect(master!)
  src.start(t0)
}

export function playSfx(name: Sfx) {
  if (!settings.sfx || settings.volume <= 0) return
  const c = ensureCtx()
  if (!c || c.state !== 'running') return
  switch (name) {
    case 'deal': // 카드를 착착 놓는 소리
      for (let i = 0; i < 3; i++) noise(c, { t: i * 0.09, d: 0.07, freq: 2600 - i * 300, g: 0.28 })
      break
    case 'chip': // 칩 딸깍
      tone(c, { f: 1900, d: 0.07, type: 'square', g: 0.07 })
      tone(c, { f: 1300, t: 0.05, d: 0.09, type: 'square', g: 0.06 })
      noise(c, { d: 0.05, freq: 5000, g: 0.12 })
      break
    case 'die': // 풀 죽는 소리
      tone(c, { f: 330, d: 0.28, type: 'triangle', g: 0.22, slide: 0.55 })
      break
    case 'check': // 톡
      tone(c, { f: 740, d: 0.08, type: 'sine', g: 0.2 })
      break
    case 'turn': // 내 차례! 띠링
      tone(c, { f: 880, d: 0.14, type: 'sine', g: 0.22 })
      tone(c, { f: 1320, t: 0.11, d: 0.2, type: 'sine', g: 0.2 })
      break
    case 'win': // 승리 팡파레
      ;[523, 659, 784, 1047].forEach((f, i) => tone(c, { f, t: i * 0.11, d: 0.28, type: 'triangle', g: 0.22 }))
      tone(c, { f: 1568, t: 0.46, d: 0.5, type: 'sine', g: 0.16 })
      break
    case 'lose': // 아쉬운 하강음
      ;[392, 330, 262].forEach((f, i) => tone(c, { f, t: i * 0.14, d: 0.3, type: 'triangle', g: 0.2 }))
      break
    case 'shuffle': // 촤르르
      for (let i = 0; i < 9; i++) noise(c, { t: i * 0.055, d: 0.06, freq: 3000 + (i % 3) * 700, g: 0.2 })
      break
    case 'emote_ugh': // 아 패가... : 풀 죽은 와~악 (아래로 휘청)
      tone(c, { f: 392, d: 0.32, type: 'sawtooth', g: 0.1, slide: 0.6 })
      tone(c, { f: 311, t: 0.3, d: 0.45, type: 'sawtooth', g: 0.1, slide: 0.55 })
      break
    case 'emote_taunt': // 쫄? : 약 올리는 "띠로리롱"
      ;[784, 988, 784, 1175].forEach((f, i) => tone(c, { f, t: i * 0.09, d: 0.12, type: 'square', g: 0.07 }))
      tone(c, { f: 1568, t: 0.4, d: 0.22, type: 'triangle', g: 0.1, slide: 1.25 })
      break
    case 'emote_yes': // 아싸! : 신나게 올라가는 반짝임
      ;[523, 659, 784, 1047, 1319].forEach((f, i) => tone(c, { f, t: i * 0.07, d: 0.2, type: 'triangle', g: 0.18 }))
      tone(c, { f: 2093, t: 0.38, d: 0.35, type: 'sine', g: 0.08 })
      noise(c, { t: 0.36, d: 0.2, freq: 6500, g: 0.08 })
      break
    case 'emote_sad': // 슬퍼 : 느리게 내려가는 단조
      ;[440, 392, 349, 330].forEach((f, i) => tone(c, { f, t: i * 0.24, d: 0.42, type: 'sine', g: 0.17 }))
      break
    case 'msg': // 채팅 알림
      tone(c, { f: 1040, d: 0.07, type: 'sine', g: 0.12 })
      break
  }
}

// ───────────── 배경음악 (합성 루프) ─────────────
// Am – F – C – G, 느긋한 아르페지오 + 베이스. 100ms 마다 0.4초 앞까지 예약한다.
const CHORDS: { bass: number; notes: number[] }[] = [
  { bass: 110, notes: [220, 262, 330, 440] },
  { bass: 87.3, notes: [175, 220, 262, 349] },
  { bass: 131, notes: [262, 330, 392, 523] },
  { bass: 98, notes: [196, 247, 294, 392] },
]
const STEP = 60 / 92 / 2 // 8분음표
let musicTimer: ReturnType<typeof setInterval> | null = null
let nextStep = 0
let stepIdx = 0

function musicNote(c: AudioContext, f: number, t: number, d: number, type: OscillatorType, g: number) {
  const osc = c.createOscillator()
  const gn = c.createGain()
  osc.type = type
  osc.frequency.value = f
  gn.gain.setValueAtTime(0.0001, t)
  gn.gain.exponentialRampToValueAtTime(g, t + 0.02)
  gn.gain.exponentialRampToValueAtTime(0.0001, t + d)
  osc.connect(gn).connect(musicBus!)
  osc.start(t)
  osc.stop(t + d + 0.05)
}

function scheduleMusic() {
  const c = ctx
  if (!c || !musicBus || c.state !== 'running') return
  if (nextStep < c.currentTime) nextStep = c.currentTime + 0.05
  while (nextStep < c.currentTime + 0.4) {
    const bar = Math.floor(stepIdx / 8) % CHORDS.length
    const pos = stepIdx % 8
    const ch = CHORDS[bar]
    if (pos === 0) musicNote(c, ch.bass, nextStep, STEP * 6, 'triangle', 0.5)
    if (pos === 4) musicNote(c, ch.bass * 1.5, nextStep, STEP * 3, 'triangle', 0.3)
    const arp = [0, 1, 2, 3, 2, 1, 2, 3][pos]
    musicNote(c, ch.notes[arp], nextStep, STEP * 1.6, 'sine', 0.3)
    nextStep += STEP
    stepIdx++
  }
}

export function startMusic() {
  const c = ensureCtx()
  if (!c || musicTimer) return
  nextStep = c.currentTime + 0.1
  musicTimer = setInterval(scheduleMusic, 100)
  scheduleMusic()
}
export function stopMusic() {
  if (musicTimer) clearInterval(musicTimer)
  musicTimer = null
}

// ───────────── 설정 (React 에서 구독) ─────────────
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    /* 저장 불가 */
  }
}

export function setSound(patch: Partial<SoundSettings>) {
  settings = { ...settings, ...patch, volume: Math.min(1, Math.max(0, patch.volume ?? settings.volume)) }
  save()
  if (master && ctx) master.gain.setTargetAtTime(settings.volume, ctx.currentTime, 0.02)
  if (settings.music && settings.volume > 0) {
    unlocked = true
    startMusic()
  } else {
    stopMusic()
  }
  emit()
}

export function useSoundSettings(): SoundSettings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => settings,
    () => settings,
  )
}
