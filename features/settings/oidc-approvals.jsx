'use client'
import { useEffect, useState } from 'react'
import { Button, InlineAlert } from '../../components/ui/index.jsx'
import styles from './settings.module.css'

export default function OidcApprovals({ users }) {
  const [data, setData] = useState(null), [selected, setSelected] = useState({}), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const load = async () => {
    const r = await fetch('/api/users/oidc', { cache: 'no-store' })
    if (!r.ok) throw new Error('Keycloak 연결 요청을 불러오지 못했습니다.')
    setData(await r.json())
  }
  useEffect(() => { load().catch(e => setError(e.message)) }, [])
  const change = async body => {
    setBusy(true); setError('')
    try {
      const r = await fetch('/api/users/oidc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await r.json(); if (!r.ok) throw new Error(d.error)
      await load()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return <section className={styles.section}>
    <div className={styles.sectionHeading}><div><h3>Keycloak 계정 연결</h3><p>Keycloak 사용자와 연결할 MOA 계정을 확인해 승인하세요. MOA 계정의 역할과 프로젝트 권한을 그대로 사용합니다.</p></div><Button size="sm" disabled={busy} onClick={() => load().catch(e => setError(e.message))}>요청 확인</Button></div>
    {error && <InlineAlert tone="danger">{error}</InlineAlert>}
    {data?.pending.length === 0 && <p>승인 대기 요청이 없습니다.</p>}
    {data?.pending.map(p => <div key={p.id} className={styles.memberItem}>
      <strong>{p.name || 'Keycloak 사용자'}</strong><p>{p.email || '이메일 없음'}</p>
      <p><small>{p.issuer}<br />사용자 식별값: {p.sub}</small></p>
      <label>연결할 MOA 계정 <select value={selected[p.id] || ''} disabled={busy} onChange={e => setSelected({ ...selected, [p.id]: e.target.value })}>
        <option value="">계정을 선택하세요</option>
        {users.filter(u => !u.disabled).map(u => <option value={u.id} key={u.id}>{u.name} · {u.email} · {u.role}</option>)}
      </select></label>
      <div className={styles.actions}><Button disabled={busy || !selected[p.id]} onClick={() => change({ action: 'bind', requestId: p.id, userId: selected[p.id] })}>연결 승인</Button><Button variant="ghost" disabled={busy} onClick={() => change({ action: 'reject', requestId: p.id })}>거절</Button></div>
    </div>)}
    {data?.bindings.map(b => <div className={styles.memberItem} key={b.issuer + b.sub}>
      <strong>{users.find(u => u.id === b.userId)?.name || '삭제된 MOA 계정'}</strong><p><small>{b.issuer}<br />사용자 식별값: {b.sub}</small></p>
      <Button variant="ghost" disabled={busy} onClick={() => change({ action: 'unlink', issuer: b.issuer, sub: b.sub, userId: b.userId })}>연결 해제</Button>
    </div>)}
  </section>
}
