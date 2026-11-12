import * as THREE from 'three'

/**
 * 카드 면 텍스처를 2D 캔버스로 직접 그린다 (외부 이미지/모델 없음).
 * 앞면 텍스처는 값이 공개된 카드에 대해서만 만들어진다 → 숨겨진 카드의 값은 3D 쪽에도 존재하지 않는다.
 */
const W = 256
const H = 384
const FONT = `'Jua', 'Apple SD Gothic Neo', sans-serif`

const cache = new Map<string, THREE.CanvasTexture>()

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function finish(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

function gloss(ctx: CanvasRenderingContext2D) {
  const g = ctx.createLinearGradient(0, 0, W, H * 0.5)
  g.addColorStop(0, 'rgba(255,255,255,0.55)')
  g.addColorStop(0.5, 'rgba(255,255,255,0.08)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  rr(ctx, 10, 10, W - 20, H * 0.45, 30)
  ctx.fill()
}

export function frontTexture(n: number, tag: string | null, fontKey: number): THREE.CanvasTexture {
  const key = `f${n}|${tag ?? ''}|${fontKey}`
  const hit = cache.get(key)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  const bg = ctx.createLinearGradient(0, 0, 0, H)
  bg.addColorStop(0, '#fffafc')
  bg.addColorStop(1, '#efe4ff')
  ctx.fillStyle = bg
  rr(ctx, 0, 0, W, H, 34)
  ctx.fill()

  const color = n % 2 ? '#1f6fe0' : '#d4183c'
  const dark = n % 2 ? '#123f93' : '#7d0c24'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const size = n === 10 ? 168 : 232
  ctx.font = `${size}px ${FONT}`
  ctx.fillStyle = dark // 젤리 느낌의 두께감 그림자
  ctx.fillText(String(n), W / 2 + 5, H / 2 + 16)
  ctx.fillStyle = color
  ctx.fillText(String(n), W / 2, H / 2 + 10)
  ctx.font = `46px ${FONT}`
  ctx.fillStyle = color
  ctx.textAlign = 'left'
  ctx.fillText(String(n), 22, 46)
  ctx.textAlign = 'right'
  ctx.fillText(String(n), W - 22, H - 44)

  gloss(ctx)
  if (tag) {
    ctx.fillStyle = '#1f6fe0'
    rr(ctx, W / 2 - 52, H - 62, 104, 38, 19)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.font = `26px ${FONT}`
    ctx.fillText(tag, W / 2, H - 42)
  }
  const t = finish(c)
  cache.set(key, t)
  return t
}

export function backTexture(question: boolean, fontKey: number): THREE.CanvasTexture {
  const key = `b${question ? 'q' : ''}|${fontKey}`
  const hit = cache.get(key)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  const bg = ctx.createLinearGradient(0, 0, W, H)
  bg.addColorStop(0, '#2a1545')
  bg.addColorStop(1, '#0d1030')
  ctx.fillStyle = bg
  rr(ctx, 0, 0, W, H, 34)
  ctx.fill()
  // 다이아 무늬
  ctx.save()
  rr(ctx, 14, 14, W - 28, H - 28, 24)
  ctx.clip()
  for (let y = -H; y < H * 2; y += 44) {
    for (let x = -W; x < W * 2; x += 44) {
      const odd = ((x + y) / 44) % 2 === 0
      ctx.fillStyle = odd ? 'rgba(255,59,92,0.22)' : 'rgba(61,165,255,0.2)'
      ctx.beginPath()
      ctx.moveTo(x, y - 18)
      ctx.lineTo(x + 18, y)
      ctx.lineTo(x, y + 18)
      ctx.lineTo(x - 18, y)
      ctx.closePath()
      ctx.fill()
    }
  }
  ctx.restore()
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'
  ctx.lineWidth = 5
  rr(ctx, 14, 14, W - 28, H - 28, 24)
  ctx.stroke()
  // 가운데 엠블럼
  const g = ctx.createRadialGradient(W / 2 - 18, H / 2 - 22, 6, W / 2, H / 2, 74)
  g.addColorStop(0, question ? '#ffd1da' : '#ff9db0')
  g.addColorStop(1, question ? '#ff3b5c' : '#b3122f')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(W / 2, H / 2, 74, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'
  ctx.lineWidth = 5
  ctx.stroke()
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${question ? 110 : 70}px ${FONT}`
  ctx.fillText(question ? '?' : 'B', W / 2, H / 2 + 8)
  gloss(ctx)
  const t = finish(c)
  cache.set(key, t)
  return t
}
