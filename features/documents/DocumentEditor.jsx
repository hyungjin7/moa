'use client'
import React, { useEffect, useRef, useState } from 'react'
import { Button, Dialog, Icon, InlineAlert } from '../../components/ui/index.jsx'
import { DocumentPreview } from '../../components/doc-renderer.jsx'
import styles from './editor.module.css'

const query = (slug, doc) => new URLSearchParams({ slug, doc }).toString()
async function api(url, body, signal) {
  const response = await fetch(url, body === undefined ? { signal } : { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `요청 실패 (${response.status})`)
  return data
}
const date = value => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
const reasons = { checkpoint: '기존 문서', save: '본문 저장', restore: '버전 복원', metadata: '제목·그룹 변경' }
export default function DocumentEditor({ open, onClose, onSaved, slug, doc, title }) {
  const [source, setSource] = useState(''), [saved, setSaved] = useState(''), [revision, setRevision] = useState(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [mode, setMode] = useState('split'), [preview, setPreview] = useState(null), [previewError, setPreviewError] = useState(''), [previewing, setPreviewing] = useState(false)
  const [versions, setVersions] = useState([]), [selected, setSelected] = useState(''), [historical, setHistorical] = useState(null)
  const [discard, setDiscard] = useState(false), [restoreConfirm, setRestoreConfirm] = useState(false)
  const dirty = open && revision && source !== saved
  const input = useRef(null), selectionSequence = useRef(0)
  const endpoint = `/api/doc/source?${query(slug, doc)}`
  const loadVersions = async () => setVersions((await api(`/api/doc/history?${query(slug, doc)}`)).versions)
  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    setLoading(true); setRevision(null); setError(''); setNotice(''); setSelected(''); setHistorical(null); setMode('split'); setPreview(null)
    Promise.all([api(endpoint, undefined, abort.signal), api(`/api/doc/history?${query(slug, doc)}`, undefined, abort.signal)])
      .then(([data, h]) => { setSource(data.source); setSaved(data.source); setRevision(data.revision); setVersions(h.versions) })
      .catch(e => { if (e.name !== 'AbortError') setError(e.message) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [open, endpoint, slug, doc])
  useEffect(() => { if (open && !loading) input.current?.focus({ preventScroll: true }) }, [open, loading])
  useEffect(() => {
    if (!dirty) return
    const leave = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [dirty])
  useEffect(() => {
    if (!open || !revision || mode === 'edit' || mode === 'history') return
    const abort = new AbortController()
    setPreview(null); setPreviewError(''); setPreviewing(true)
    const timer = setTimeout(() => {
      api('/api/doc/preview', { slug, doc, source }, abort.signal)
        .then(data => setPreview(data.code)).catch(e => { if (e.name !== 'AbortError') setPreviewError(e.message) })
        .finally(() => { if (!abort.signal.aborted) setPreviewing(false) })
    }, 500)
    return () => { clearTimeout(timer); abort.abort() }
  }, [source, revision, open, mode, slug, doc])
  const save = async () => {
    if (!dirty || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const data = await api('/api/doc/source', { slug, doc, source, expectedRevision: revision })
      setSaved(data.source); setSource(data.source); setRevision(data.revision); setNotice('저장했습니다.')
      onSaved(); await loadVersions()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  useEffect(() => {
    if (!open) return
    const key = event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save() } }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  })
  const selectVersion = async id => {
    const seq = ++selectionSequence.current; setSelected(id); setHistorical(null); setError('')
    if (!id) return
    try { const data = await api(`/api/doc/history?${query(slug, doc)}&versionId=${encodeURIComponent(id)}`); if (seq === selectionSequence.current) setHistorical(data) }
    catch (e) { if (seq === selectionSequence.current) setError(e.message) }
  }
  const restore = async () => {
    setRestoreConfirm(false); setBusy(true); setError(''); setNotice('')
    try {
      const data = await api('/api/doc/restore', { slug, doc, versionId: selected, expectedRevision: revision })
      setSource(data.source); setSaved(data.source); setRevision(data.revision); setSelected(''); setHistorical(null)
      setNotice('선택한 버전으로 복원했습니다. 복원 전 내용도 이전 버전에 보관했습니다.'); onSaved(); await loadVersions()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const close = () => { if (busy) return; if (dirty) setDiscard(true); else onClose() }
  return <>
    <Dialog open={open} onClose={close} title="문서 편집" description={`${title} · Markdown / MDX`} className={styles.dialog} initialFocus={input}
      footer={<><span className={styles.saveState}>{dirty ? '저장하지 않은 변경' : revision ? '저장됨' : ''}</span><Button onClick={close} disabled={busy}>닫기</Button><Button variant="primary" onClick={save} loading={busy} disabled={!dirty || loading}>저장</Button></>}>
      {error && <InlineAlert tone="danger" title="작업을 완료하지 못했습니다">{error}</InlineAlert>}
      {notice && <InlineAlert tone="success">{notice}</InlineAlert>}
      {loading ? <p role="status">문서를 불러오는 중입니다.</p> : revision && <>
        <div className={styles.toolbar} aria-label="편집 보기">
          {[['edit', '편집'], ['split', '나란히 보기'], ['preview', '미리보기'], ['history', '이전 버전']].map(([value, label]) => <Button key={value} size="sm" variant={mode === value ? 'secondary' : 'ghost'} aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</Button>)}
          <small>최대 512KiB · 최근 50개 버전 · ⌘/Ctrl+S 저장</small>
        </div>
        <div className={`${styles.workspace} ${mode === 'split' ? styles.split : ''}`}>
          {(mode === 'edit' || mode === 'split') && <label className={styles.sourcePanel}><span>Markdown / MDX 원문</span><textarea ref={input} aria-label="Markdown 원문" value={source} disabled={busy} spellCheck={false} onChange={event => { setSource(event.target.value); setNotice('') }} /></label>}
          {(mode === 'preview' || mode === 'split') && <section className={styles.previewPanel} aria-label="문서 미리보기"><strong>미리보기</strong>
            {previewing && <p role="status">미리보기를 만드는 중입니다.</p>}
            {previewError && <InlineAlert tone="danger" title="문법을 확인해 주세요">{previewError}</InlineAlert>}
            {preview && <article className="page moa-prose"><DocumentPreview code={preview} /></article>}
          </section>}
          {mode === 'history' && <section className={styles.historyPanel} aria-label="이전 버전"><p>저장 전 내용도 자동 보관됩니다. 버전을 선택해 원문을 확인한 뒤 복원하세요.</p>
            {versions.length ? <><label>복원할 버전<select aria-label="복원할 버전" value={selected} disabled={busy} onChange={e => selectVersion(e.target.value)}><option value="">버전을 선택하세요</option>{versions.map(v => <option key={v.id} value={v.id}>{date(v.createdAt)} KST · {reasons[v.reason] || v.reason} · {v.actor}{v.current ? ' · 현재 내용' : ''}</option>)}</select></label>
              {selected && !historical && <p role="status">버전을 불러오는 중입니다.</p>}
              {historical && <><textarea aria-label="선택한 버전 원문" readOnly value={historical.source} /><Button onClick={() => setRestoreConfirm(true)} disabled={busy || historical.version.revision === revision}><Icon name="history" size={16} />이 버전으로 복원</Button></>}
            </> : <p>첫 저장 후 기존 내용과 저장한 내용이 여기에 표시됩니다.</p>}
          </section>}
        </div>
      </>}
    </Dialog>
    <Dialog open={discard} onClose={() => setDiscard(false)} title="저장하지 않은 변경이 있습니다" description="편집 내용을 버리고 닫을까요?" footer={<><Button onClick={() => setDiscard(false)}>계속 편집</Button><Button variant="primary" onClick={() => { setDiscard(false); onClose() }}>변경 버리고 닫기</Button></>} />
    <Dialog open={restoreConfirm} onClose={() => setRestoreConfirm(false)} title="이 버전으로 복원할까요?" description="현재 저장된 내용은 이전 버전에 보관됩니다. 아직 저장하지 않은 편집 내용은 사라집니다." footer={<><Button onClick={() => setRestoreConfirm(false)}>취소</Button><Button variant="primary" onClick={restore}>복원 실행</Button></>} />
  </>
}
