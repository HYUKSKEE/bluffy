import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** .env 가 비어 있으면 설정 안내 화면을 보여주기 위한 플래그 */
export const isConfigured = Boolean(url && anonKey && !url.includes('YOUR-PROJECT'))

// anon public 키만 사용한다. (service_role 키는 프론트엔드에 절대 넣지 않는다)
export const supabase: SupabaseClient = createClient(url ?? 'http://localhost', anonKey ?? 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  realtime: { params: { eventsPerSecond: 10 } },
})

let authPromise: Promise<string> | null = null

/** 익명 로그인 (세션은 localStorage 에 유지되어 새로고침/재접속 시 같은 사용자로 복귀) */
export function ensureAuth(): Promise<string> {
  if (!authPromise) {
    authPromise = (async () => {
      const { data } = await supabase.auth.getSession()
      if (data.session) return data.session.user.id
      const { data: res, error } = await supabase.auth.signInAnonymously()
      if (error || !res.user) throw error ?? new Error('anonymous sign-in failed')
      return res.user.id
    })().catch((e) => {
      authPromise = null // 다음 시도에서 재시도 가능
      throw e
    })
  }
  return authPromise
}
