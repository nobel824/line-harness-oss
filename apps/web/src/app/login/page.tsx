'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getApiBase } from '@/lib/api-base'

export default function LoginPage() {
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [authMode, setAuthMode] = useState<'loading' | 'api_key' | 'hybrid' | 'access'>('loading')
  const [accessLoginUrl, setAccessLoginUrl] = useState<string | null>(null)
  const router = useRouter()

  useEffect(() => {
    const loadConfig = async () => {
      const apiUrl = getApiBase()
      if (!apiUrl) {
        setError('NEXT_PUBLIC_API_URL is not set in build env')
        return
      }
      try {
        const res = await fetch(`${apiUrl}/api/auth/config`, { credentials: 'include' })
        const config = await res.json() as {
          mode?: 'api_key' | 'hybrid' | 'access'
          accessLoginUrl?: string | null
          error?: string
        }
        if (!res.ok || !config.mode) {
          setError(config.error ?? 'ログイン設定を読み込めませんでした')
          return
        }
        setAuthMode(config.mode)
        setAccessLoginUrl(config.accessLoginUrl ?? null)
      } catch {
        setError('ログイン設定の取得に失敗しました')
      }
    }
    void loadConfig()
  }, [])

  const startAccessLogin = () => {
    if (accessLoginUrl) window.location.assign(accessLoginUrl)
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const apiUrl = getApiBase()
      if (!apiUrl) {
        setError('NEXT_PUBLIC_API_URL is not set in build env')
        setLoading(false)
        return
      }
      // Exchange the API key for an HttpOnly session cookie. The key is never
      // stored in localStorage (removes the XSS-exposed credential).
      const res = await fetch(`${apiUrl}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      })

      if (res.ok) {
        localStorage.removeItem('lh_api_key')
        try {
          const loginData = await res.json()
          if (loginData.success && loginData.data) {
            localStorage.setItem('lh_staff_name', loginData.data.name)
            localStorage.setItem('lh_staff_role', loginData.data.role)
          }
          // Cache the CSRF token for mutating requests (double-submit).
          if (loginData.csrfToken) {
            localStorage.setItem('lh_csrf', loginData.csrfToken)
          }
        } catch {
          // Profile / CSRF caching is best-effort.
        }
        router.push('/')
      } else if (res.status === 401) {
        setError('APIキーが正しくありません')
      } else {
        // Surface topology / configuration errors (e.g. cross-site cookie guard).
        let message = 'ログインに失敗しました'
        try {
          const data = await res.json()
          if (data?.error) message = data.error
        } catch {
          // keep default message
        }
        setError(message)
      }
    } catch {
      setError('接続に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#06C755' }}>
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-lg mx-auto mb-3" style={{ backgroundColor: '#06C755' }}>
            H
          </div>
          <h1 className="text-xl font-bold text-gray-900">L Harness</h1>
          <p className="text-sm text-gray-500 mt-1">管理画面にログイン</p>
        </div>

        {authMode === 'loading' && !error && (
          <p className="text-sm text-gray-500 text-center">ログイン設定を読み込み中...</p>
        )}

        {(authMode === 'access' || authMode === 'hybrid') && accessLoginUrl && (
          <button
            type="button"
            onClick={startAccessLogin}
            className="w-full py-3 text-white font-medium rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            メールで認証してログイン
          </button>
        )}

        {authMode === 'hybrid' && accessLoginUrl && (
          <div className="flex items-center gap-3 my-5 text-xs text-gray-400">
            <span className="h-px flex-1 bg-gray-200" />
            または APIキーでログイン
            <span className="h-px flex-1 bg-gray-200" />
          </div>
        )}

        {(authMode === 'api_key' || authMode === 'hybrid') && (
        <form onSubmit={handleLogin} className={authMode === 'hybrid' && !accessLoginUrl ? 'mt-5' : ''}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="APIキーを入力"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              autoFocus
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 mb-4">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !apiKey}
            className="w-full py-3 text-white font-medium rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{ backgroundColor: '#06C755' }}
          >
            {loading ? 'ログイン中...' : 'ログイン'}
          </button>
        </form>
        )}

        {error && authMode !== 'api_key' && authMode !== 'hybrid' && (
          <p className="text-sm text-red-600 mt-4">{error}</p>
        )}
      </div>
    </div>
  )
}
