import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { req } from '@/lib/api/net'

/** The capability stays in the URL fragment and is cleared after successful use. */
export function SetupPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault(); setError('')
    if (password.length < 8) { setError('密码至少 8 位'); return }
    if (password !== confirm) { setError('两次输入的密码不一致'); return }
    setBusy(true)
    try {
      await req('/api/auth/setup-password', { method: 'POST', body: JSON.stringify({ token, password }) })
      setPassword(''); setConfirm(''); setDone(true)
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/login`)
    } catch (err) { setError(err instanceof Error ? err.message : '密码设置失败，请重试') }
    finally { setBusy(false) }
  }
  return <div data-testid="setup-password-form">
    <h1 className="text-2xl font-semibold text-fg-strong">{done ? '密码已设置' : '设置账号密码'}</h1>
    {done ? <div className="mt-4 grid gap-4"><p className="text-sm text-fg-muted">请使用你的邮箱和新密码登录。</p><Button onClick={() => window.location.reload()}>前往登录</Button></div> : <>
      <p className="mt-2 text-sm text-fg-muted">设置你自己的密码后即可登录。此链接只能成功使用一次。</p>
      <form className="mt-5 grid gap-4" onSubmit={(e) => void submit(e)}>
        <div className="grid gap-1"><Label htmlFor="setup-password">新密码</Label><Input id="setup-password" size="xl" type="password" required minLength={8} maxLength={1024} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        <div className="grid gap-1"><Label htmlFor="setup-confirm">确认密码</Label><Input id="setup-confirm" size="xl" type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
        {error && <p className="text-sm text-danger-fg" role="alert">{error}</p>}
        <Button type="submit" size="xl" disabled={busy}>{busy ? '保存中…' : '设置密码'}</Button>
      </form>
    </>}
  </div>
}
