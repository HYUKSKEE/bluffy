import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { RoundedBox } from '@react-three/drei'
import * as THREE from 'three'
import { backTexture, frontTexture, labelTexture } from './cardTextures'

export interface StageCard {
  /** 공개된 값. null 이면 뒷면(값은 클라이언트에 존재하지 않음) */
  value: number | null
  /** A 모드: 상대에게 공개된 카드 표식 */
  tag?: string | null
  /** B 모드: 내 카드 뒷면에 "?" + 이마 테이프 연출 */
  forehead?: boolean
}

export interface StageOpp {
  id: string
  /** 이름표 (예: "철수 · 87") */
  label: string
  cards: StageCard[]
  folded: boolean
  /** 탈락/나감: 카드를 받지 않음 */
  out: boolean
  /** 지금 이 사람 차례 */
  active: boolean
  win: boolean
}

export interface StageProps {
  opps: StageOpp[]
  me: { cards: StageCard[]; win: boolean; folded: boolean; active: boolean; label: string; out: boolean }
  pot: number
  /** 같은 판 안에서는 유지, 새 판이면 바뀌는 키 → 카드가 새로 "통" 하고 나타난다 */
  handKey: string
}

/** 폰트가 로드되면 텍스처를 다시 그리기 위한 키 */
function useFontKey() {
  const [k, setK] = useState(0)
  useEffect(() => {
    let alive = true
    document.fonts?.load(`100px Jua`, '0123456789?B공개다이탈락').then(() => alive && setK(1)).catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  return k
}

const CARD_W = 1.4
const CARD_H = 2.0

/** 상대 인원수별 배치 (월드 좌표, 카메라 정면). 3~4명은 2줄. */
function oppSlots(n: number): { x: number; y: number; s: number }[] {
  if (n <= 1) return [{ x: 0, y: 2.0, s: 1 }]
  if (n === 2) return [{ x: -1.75, y: 2.15, s: 0.78 }, { x: 1.75, y: 2.15, s: 0.78 }]
  if (n === 3) return [{ x: -1.6, y: 2.2, s: 0.48 }, { x: 1.6, y: 2.2, s: 0.48 }, { x: 0, y: 0.6, s: 0.48 }]
  if (n === 4) return [{ x: -1.6, y: 2.2, s: 0.48 }, { x: 1.6, y: 2.2, s: 0.48 }, { x: -1.6, y: 0.6, s: 0.48 }, { x: 1.6, y: 0.6, s: 0.48 }]
  // 5명(관전 화면): 윗줄 3, 아랫줄 2
  return [{ x: -2.4, y: 2.2, s: 0.46 }, { x: 0, y: 2.2, s: 0.46 }, { x: 2.4, y: 2.2, s: 0.46 }, { x: -1.2, y: 0.6, s: 0.46 }, { x: 1.2, y: 0.6, s: 0.46 }]
}

function Card3D({
  card, x, y, scale, tint, glow, hop, dim, delay, tilt,
}: {
  card: StageCard
  x: number
  y: number
  scale: number
  tint: 'red' | 'blue'
  glow: boolean
  hop: boolean
  dim: boolean
  delay: number
  tilt: number
}) {
  const fontKey = useFontKey()
  const group = useRef<THREE.Group>(null)
  const body = useRef<THREE.MeshPhysicalMaterial>(null)
  const s = useRef({ rot: Math.PI, scale: 0, hop: 0, born: performance.now() + delay * 1000 })
  const faceUp = card.value !== null
  const prevUp = useRef(faceUp)

  useEffect(() => {
    if (prevUp.current !== faceUp) s.current.hop = 1 // 뒤집힐 때 통 튀어 오른다
    prevUp.current = faceUp
  }, [faceUp])
  useEffect(() => {
    if (hop) s.current.hop = 1.6
  }, [hop])

  const front = useMemo(
    () => (card.value !== null ? frontTexture(card.value, card.tag ?? null, fontKey) : null),
    [card.value, card.tag, fontKey],
  )
  const back = useMemo(() => backTexture(Boolean(card.forehead), fontKey), [card.forehead, fontKey])

  useFrame((st, dt) => {
    const g = group.current
    if (!g) return
    const q = s.current
    const t = st.clock.elapsedTime
    if (performance.now() < q.born) {
      g.scale.setScalar(0.0001)
      return
    }
    q.scale += (1 - q.scale) * Math.min(1, dt * 9)
    const overshoot = 1 + Math.sin(Math.min(1, q.scale) * Math.PI) * 0.12 // 통통
    g.scale.setScalar(Math.max(0.0001, q.scale * overshoot * scale * (dim ? 0.92 : 1)))
    const target = faceUp ? 0 : Math.PI
    q.rot += (target - q.rot) * Math.min(1, dt * 7)
    q.hop = Math.max(0, q.hop - dt * 1.7)
    g.rotation.y = q.rot
    g.rotation.x = tilt + (dim ? 0.25 : 0)
    g.rotation.z = Math.sin(t * 1.4 + x * 2) * 0.025 + (card.forehead ? Math.sin(t * 3 + x) * 0.04 : 0)
    g.position.set(x, y + Math.sin(Math.min(1, q.hop) * Math.PI) * 0.7 * scale + Math.sin(t * 1.6 + x) * 0.03 * scale, dim ? -0.3 : 0)
    if (body.current) body.current.emissiveIntensity = glow ? 0.35 + Math.sin(t * 6) * 0.2 : 0
  })

  const edge = dim ? '#4a4a58' : tint === 'red' ? '#ff3b5c' : '#3da5ff'
  return (
    <group ref={group}>
      <RoundedBox args={[CARD_W, CARD_H, 0.22]} radius={0.16} smoothness={5}>
        <meshPhysicalMaterial ref={body} color={edge} roughness={0.28} clearcoat={1} clearcoatRoughness={0.15} emissive={edge} emissiveIntensity={0} />
      </RoundedBox>
      {front && (
        <mesh position={[0, 0, 0.116]}>
          <planeGeometry args={[CARD_W - 0.12, CARD_H - 0.14]} />
          <meshStandardMaterial map={front} transparent roughness={0.4} color={dim ? '#8a8a96' : '#ffffff'} />
        </mesh>
      )}
      <mesh position={[0, 0, -0.116]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[CARD_W - 0.12, CARD_H - 0.14]} />
        <meshStandardMaterial map={back} transparent roughness={0.35} color={dim ? '#8a8a96' : '#ffffff'} />
      </mesh>
      {card.forehead && !faceUp && (
        // 이마에 붙인 것처럼 보이는 테이프
        <mesh position={[0.05, CARD_H / 2 - 0.2, -0.14]} rotation={[0, Math.PI, 0.12]}>
          <planeGeometry args={[1.0, 0.3]} />
          <meshStandardMaterial color="#ffd65e" transparent opacity={0.88} roughness={0.3} />
        </mesh>
      )}
    </group>
  )
}

/** 이름표 (닉네임 · 칩 / 상태). 차례인 사람은 파란 테두리로 강조 */
function NameTag({ text, x, y, mood, wide }: { text: string; x: number; y: number; mood: 'normal' | 'active' | 'out' | 'win'; wide: number }) {
  const fontKey = useFontKey()
  const tex = useMemo(() => labelTexture(text, mood, fontKey), [text, mood, fontKey])
  return (
    <mesh position={[x, y, 0.3]}>
      <planeGeometry args={[wide, wide * 0.25]} />
      <meshBasicMaterial map={tex} transparent toneMapped={false} />
    </mesh>
  )
}

/** 젤리 코인 더미: 판돈만큼 쌓인다 (최대 16개까지 표현) */
function PotStack({ pot }: { pot: number }) {
  const n = Math.min(pot, 16)
  const group = useRef<THREE.Group>(null)
  const mat = useMemo(
    () => new THREE.MeshPhysicalMaterial({ color: '#3da5ff', roughness: 0.18, clearcoat: 1, emissive: '#1b5fd1', emissiveIntensity: 0.25 }),
    [],
  )
  useFrame((st) => {
    if (group.current) group.current.position.y = Math.sin(st.clock.elapsedTime * 2) * 0.03
  })
  return (
    <group ref={group}>
      {Array.from({ length: n }).map((_, i) => {
        const col = i % 2
        const row = Math.floor(i / 2)
        return (
          <mesh key={i} material={mat} position={[(col - 0.5) * 0.9 + ((i * 37) % 7) * 0.012, -1.2 + row * 0.12, 0.2 + col * 0.12]} rotation={[0, (i * 0.7) % 3, 0]}>
            <cylinderGeometry args={[0.42, 0.42, 0.1, 28]} />
          </mesh>
        )
      })}
    </group>
  )
}

function Scene({ opps, me, pot, handKey }: StageProps) {
  const slots = oppSlots(opps.length)
  const hasResult = opps.some((o) => o.win) || me.win
  return (
    <>
      <ambientLight intensity={0.95} />
      <directionalLight position={[3, 6, 7]} intensity={2.2} />
      <pointLight position={[-6, 1, 4]} intensity={45} color="#ff3b5c" />
      <pointLight position={[6, -1, 4]} intensity={45} color="#3da5ff" />

      {opps.map((o, k) => {
        const sl = slots[k]
        const gap = CARD_W * sl.s * 0.62
        return (
          <group key={`${handKey}-${o.id}`}>
            {o.cards.map((c, i) => (
              <Card3D
                key={i} card={c} x={sl.x + (i - 0.5) * gap * 2} y={sl.y} scale={sl.s} tint="red"
                glow={o.win} hop={o.win} dim={o.folded} delay={0.05 * k + i * 0.1} tilt={-0.12}
              />
            ))}
            <NameTag text={o.label} x={sl.x} y={sl.y + (CARD_H * sl.s) / 2 + 0.3} wide={opps.length >= 3 ? 1.7 : 2.0}
              mood={o.win ? 'win' : o.out ? 'out' : o.folded ? 'out' : o.active ? 'active' : 'normal'} />
          </group>
        )
      })}

      <PotStack pot={pot} />

      <group key={`${handKey}-me`}>
        {me.cards.map((c, i) => (
          <Card3D
            key={i} card={c} x={(i - 0.5) * (CARD_W + 0.34)} y={-2.5} scale={0.92} tint="blue"
            glow={me.win} hop={me.win} dim={me.folded && !hasResult} delay={0.3 + i * 0.12} tilt={c.forehead ? -0.32 : -0.12}
          />
        ))}
      </group>
    </>
  )
}

/** WebGL 을 쓸 수 없는 환경을 위한 2D 대체 표시 */
class StageBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function Fallback({ opps, me }: Pick<StageProps, 'opps' | 'me'>) {
  const row = (name: string, cards: StageCard[], dim = false) => (
    <div className={`flex items-center justify-center gap-2 ${dim ? 'opacity-50' : ''}`}>
      <span className="w-24 truncate text-sm text-muted">{name}</span>
      {cards.map((c, i) => (
        <div key={i} className="flex h-16 w-11 items-center justify-center rounded-xl bg-surface2 text-2xl shadow-lg">{c.value ?? '?'}</div>
      ))}
    </div>
  )
  return (
    <div className="flex h-full flex-col justify-around">
      {opps.map((o) => <div key={o.id}>{row(o.label, o.cards, o.folded)}</div>)}
      {row(me.label, me.cards, me.folded)}
    </div>
  )
}

export default function MatchStage(props: StageProps) {
  return (
    <div className="relative h-full w-full">
      <StageBoundary fallback={<Fallback opps={props.opps} me={props.me} />}>
        <Canvas dpr={[1, 2]} camera={{ position: [0, 0.8, 10.5], fov: 38 }} gl={{ alpha: true, antialias: true }}>
          <Scene {...props} />
        </Canvas>
      </StageBoundary>
    </div>
  )
}
