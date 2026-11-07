import { guardAdmin, j } from '../../../../lib/api.mjs'
import { sameOrigin } from '../../../../lib/oidc.mjs'
import { changeStore } from '../../../../lib/oidc-store.mjs'
import { findUserById } from '../../../../lib/users.mjs'

export async function GET(req) {
  const denied = guardAdmin(req); if (denied) return denied
  return j(changeStore(d => ({ pending: d.pending, bindings: d.bindings })))
}
export async function POST(req) {
  const denied = guardAdmin(req); if (denied) return denied
  if (!sameOrigin(req)) return j({ error: '잘못된 요청 출처입니다.' }, 403)
  const body = await req.json().catch(() => ({}))
  const result = changeStore(d => {
    if (body.action === 'unlink') {
      const binding = d.bindings.find(b => b.userId === body.userId && b.sub === body.sub && b.issuer === body.issuer)
      if (!binding) return { error: '연결을 찾지 못했습니다.' }
      d.bindings = d.bindings.filter(b => b !== binding)
      d.sessions = d.sessions.filter(s => !(s.issuer === binding.issuer && s.sub === binding.sub))
      return { ok: true }
    }
    const pending = d.pending.find(p => p.id === body.requestId)
    if (!pending) return { error: '요청이 없거나 만료됐습니다.' }
    if (body.action === 'reject') { d.pending = d.pending.filter(p => p !== pending); return { ok: true } }
    if (body.action !== 'bind') return { error: '잘못된 작업입니다.' }
    const user = findUserById(body.userId)
    if (!user || user.disabled) return { error: '활성 MOA 계정을 선택하세요.' }
    if (d.bindings.some(b => b.issuer === pending.issuer && (b.sub === pending.sub || b.userId === user.id))) return { error: '이미 연결된 계정입니다. 기존 연결을 먼저 해제하세요.' }
    d.bindings.push({ issuer: pending.issuer, sub: pending.sub, userId: user.id, linkedAt: new Date().toISOString() })
    d.pending = d.pending.filter(p => p !== pending)
    return { ok: true }
  })
  return j(result, result.error ? 400 : 200)
}
