import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import Home from './pages/Home'
import Create from './pages/Create'
import Room from './pages/Room'
import Admin from './pages/Admin'
import Result from './pages/Result'
import Practice from './pages/Practice'
import { ConfigScreen, Spinner } from './components/ui'
import { isConfigured } from './lib/supabase'

// 연출 확인용 미리보기(개발 서버에서만 라우트가 열린다)
const Demo = import.meta.env.DEV ? lazy(() => import('./pages/Demo')) : null

export default function App() {
  // 연습 게임은 서버 없이 동작하므로 Supabase 설정이 없어도 열린다
  if (!isConfigured) {
    return (
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route path="/practice" element={<Practice />} />
          <Route path="*" element={<ConfigScreen />} />
        </Routes>
      </Suspense>
    )
  }
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/create" element={<Create />} />
        <Route path="/practice" element={<Practice />} />
        <Route path="/r/:id" element={<Room />} />
        <Route path="/r/:id/admin" element={<Admin />} />
        <Route path="/r/:id/result" element={<Result />} />
        {Demo && <Route path="/demo" element={<Demo />} />}
        <Route path="*" element={<Home />} />
      </Routes>
    </Suspense>
  )
}
