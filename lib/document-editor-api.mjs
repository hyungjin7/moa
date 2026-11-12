import { getAuth, j } from './api.mjs'
import { moveDocument, trashDocument, listTrash, restoreTrashedDocument } from './document-management.mjs'
import { editorDocument, readDocument, previewDocument, saveDocument, documentHistory, historicalSource, restoreDocument, SOURCE_LIMIT } from './document-editor.mjs'
export async function documentEditorAPI(req, action) {
  const auth = getAuth(req)
  if (!auth) return j({ error: 'Login required.' }, 401)
  if (auth.role !== 'admin') return j({ error: 'Admins only.' }, 403)
  const mutation = req.method !== 'GET'
  if (mutation) {
    const url = new URL(req.url)
    const origin = process.env.MOA_PUBLIC_ORIGIN ? new URL(process.env.MOA_PUBLIC_ORIGIN).origin : `${url.protocol}//${req.headers.get('host') || url.host}`
    if (req.headers.get('origin') !== origin) return j({ error: '다른 사이트의 요청은 허용하지 않습니다.' }, 403)
    if (!req.headers.get('content-type')?.includes('application/json')) return j({ error: 'JSON 요청이 필요합니다.' }, 415)
    if (Number(req.headers.get('content-length')) > SOURCE_LIMIT * 8) return j({ error: '요청이 너무 큽니다.' }, 413)
  }
  try {
    let input
    if (mutation) {
      // Bound the stream too: chunked requests must not bypass Content-Length limits.
      const reader = req.body?.getReader(); let bytes = 0, chunks = []
      if (!reader) return j({ error: '요청 본문이 필요합니다.' }, 400)
      for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > SOURCE_LIMIT * 8) { await reader.cancel(); return j({ error: '요청이 너무 큽니다.' }, 413) } chunks.push(Buffer.from(value)) }
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return j({ error: '잘못된 JSON입니다.' }, 400) }
    } else input = Object.fromEntries(new URL(req.url).searchParams)
    if (!input || typeof input !== 'object' || Array.isArray(input)) return j({ error: 'JSON 객체가 필요합니다.' }, 400)
    const actor = auth.user?.name || auth.user?.email || 'Owner'
    if (action === 'manage') {
      let result
      if (!mutation) result = { items: listTrash() }
      else if (input.action === 'move') result = await moveDocument(input.slug, input.doc, input.targetSlug, input.expectedRevision)
      else if (input.action === 'trash') result = await trashDocument(input.slug, input.doc, input.expectedRevision, actor)
      else if (input.action === 'restore') result = await restoreTrashedDocument(input.id)
      else throw Object.assign(new Error('지원하지 않는 문서 작업입니다.'), { status: 400 })
      return j(result)
    }
    const target = editorDocument(input.slug, input.doc)
    let result
    if (action === 'read') result = readDocument(target)
    if (action === 'preview') result = await previewDocument(target, input.source)
    if (action === 'save') result = await saveDocument(target, { source: input.source, expectedRevision: input.expectedRevision, actor })
    if (action === 'history') result = input.versionId ? historicalSource(target, input.versionId) : { versions: documentHistory(target) }
    if (action === 'restore') result = await restoreDocument(target, { versionId: input.versionId, expectedRevision: input.expectedRevision, actor })
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
  } catch (e) { return j({ error: e.status ? e.message : '문서 작업에 실패했습니다. 원본을 확인한 뒤 다시 시도하세요.' }, e.status || 500) }
}
