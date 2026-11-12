'use client'
import React, { useState } from 'react'
import { Button, Dialog, Field, Icon, InlineAlert, Input } from '../../components/ui/index.jsx'
import styles from './manager.module.css'

async function api(url, body) {
  const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `요청 실패 (${r.status})`)
  return data
}
export default function DocumentManager({ slug, doc, projects = [], trashOnly = false, onChanged }) {
  const [mode, setMode] = useState(''), [target, setTarget] = useState(''), [group, setGroup] = useState('')
  const [revision, setRevision] = useState(null), [items, setItems] = useState([])
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const open = async next => {
    setMode(next); setError(''); setBusy(true); setRevision(null); setTarget(slug || ''); setGroup(doc?.group || '')
    try {
      if (next === 'bin') setItems((await api('/api/doc/manage')).items)
      else setRevision((await api('/api/doc/source?' + new URLSearchParams({ slug, doc: doc.slug }))).revision)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const run = async () => {
    setBusy(true); setError('')
    try {
      if (mode === 'move' && target === slug) {
        await api('/api/doc/update', { slug, doc: doc.slug, group })
        setMode(''); onChanged?.(); return
      }
      const result = await api('/api/doc/manage', { action: mode === 'move' ? 'move' : 'trash', slug, doc: doc.slug, targetSlug: target, expectedRevision: revision })
      location.assign(result.url || '/')
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const restore = async id => {
    setBusy(true); setError('')
    try { const result = await api('/api/doc/manage', { action: 'restore', id }); location.assign(result.url) }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const close = () => { if (!busy) setMode('') }
  return <>
    {!trashOnly && <>
      <Button size="sm" variant="ghost" onClick={() => open('move')}><Icon name="folder" size={16} />이동</Button>
      <Button size="sm" variant="ghost" onClick={() => open('delete')}><Icon name="trash" size={16} />삭제</Button>
    </>}
    <Button size="sm" variant="ghost" onClick={() => open('bin')}><Icon name="history" size={16} />휴지통</Button>
    <Dialog open={!!mode} onClose={close} title={mode === 'bin' ? '문서 휴지통' : mode === 'move' ? '글 이동' : '글을 휴지통으로 이동할까요?'}
      description={mode === 'bin' ? '삭제한 글과 이전 버전은 보관됩니다. 원래 위치로 복원할 수 있습니다.' : doc?.title}
      footer={<><Button onClick={close} disabled={busy}>닫기</Button>{mode !== 'bin' && <Button variant={mode === 'delete' ? 'danger' : 'primary'} onClick={run} loading={busy} disabled={!revision || (mode === 'move' && !target)}>{mode === 'move' ? '이동' : '휴지통으로 이동'}</Button>}</>}>
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      {mode === 'move' && <div className={styles.form}>
        <Field label="대상 프로젝트" htmlFor="document-target-project"><select id="document-target-project" value={target} onChange={e => setTarget(e.target.value)} disabled={busy}>
          {projects.filter(p => !p.demo).map(p => <option key={p.slug} value={p.slug}>{p.title}</option>)}
        </select></Field>
        {target === slug ? <><Field label="대상 그룹" hint="기존 그룹 이름을 선택하거나 새 그룹 이름을 입력하세요. 비우면 그룹 밖으로 이동합니다.">
          <Input aria-label="대상 그룹" list="document-target-groups" maxLength={200} value={group} onChange={e => setGroup(e.target.value)} disabled={busy} />
        </Field>
          <datalist id="document-target-groups">{[...new Set(projects.find(p => p.slug === slug)?.docs?.map(d => d.group).filter(Boolean))].map(g => <option key={g} value={g} />)}</datalist>
        </> : <p>글과 이전 버전을 함께 옮깁니다. 현재 그룹은 유지하며, 대상 프로젝트에 초대된 회원에게 보이게 됩니다. 같은 이름의 글은 덮어쓰지 않습니다. 기존 공유 링크는 해제됩니다.</p>}
      </div>}
      {mode === 'delete' && <p>목록과 검색에서 글을 숨기고 휴지통에 보관합니다. 본문과 이전 버전은 복원할 수 있습니다. 기존 공유 링크는 해제됩니다.</p>}
      {mode === 'bin' && <div className={styles.items}>
        {busy && <p role="status">처리 중입니다.</p>}
        {!busy && items.length === 0 && <p>휴지통이 비어 있습니다.</p>}
        {items.map(item => <div key={item.id} className={styles.item}>
          <div><strong>{item.title}</strong><p>{item.slug} · {new Date(item.deletedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p></div>
          <Button size="sm" onClick={() => restore(item.id)} disabled={busy}>복원</Button>
        </div>)}
      </div>}
    </Dialog>
  </>
}
