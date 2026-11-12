// Admin-only document relocation and recoverable deletion. Nothing is permanently purged.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ROOT, ALLOW, PROJECTS, SHARES } from './paths.mjs'
import { buildIndex, parseDocMeta } from './content.mjs'
import { DocumentError, editorDocument, readDocument, revisionOf, previewDocument, historyDir } from './document-editor.mjs'

const locks = globalThis[Symbol.for('moa.document-editor.locks')] ||= new Set()
const valid = s => typeof s === 'string' && /^[\w.\-가-힣 ]+$/.test(s) && s !== '.' && s !== '..'
const within = (p, root) => p === root || p.startsWith(root + path.sep)
const exists = p => { try { fs.lstatSync(p); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e } }
function directory(p, create = false) {
  if (!exists(p) && create) fs.mkdirSync(p, { mode: 0o700 })
  if (exists(p) && (!fs.lstatSync(p).isDirectory() || fs.lstatSync(p).isSymbolicLink())) throw new DocumentError('안전한 저장 폴더가 아닙니다.', 403)
  return p
}
function regular(p) {
  const s = fs.lstatSync(p)
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new DocumentError('일반 문서 파일만 처리할 수 있습니다.', 403)
  return s
}
function destination(slug, doc) {
  if (!valid(slug) || !valid(doc)) throw new DocumentError('잘못된 문서 주소입니다.')
  const project = buildIndex().projects.find(p => p.slug === slug)
  if (project?.demo) throw new DocumentError('예시 프로젝트로 이동할 수 없습니다.', 403)
  let root
  try { root = fs.realpathSync(project?.path || path.join(PROJECTS, slug)) } catch { throw new DocumentError('대상 프로젝트가 없습니다.', 404) }
  if (!fs.statSync(root).isDirectory() || !within(root, fs.realpathSync(ALLOW))) throw new DocumentError('허용된 프로젝트 폴더 밖입니다.', 403)
  return { slug, doc, file: path.join(root, doc + '.mdx') }
}
async function locked(keys, fn) {
  if (keys.some(k => locks.has(k))) throw new DocumentError('다른 문서 작업이 진행 중입니다.', 409)
  keys.forEach(k => locks.add(k))
  try { return await fn() } finally { keys.forEach(k => locks.delete(k)) }
}
function checkRevision(target, expected) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new DocumentError('원본 버전이 필요합니다.')
  const data = readDocument(target)
  if (data.revision !== expected) throw new DocumentError('문서가 변경됐습니다. 새로 불러온 뒤 다시 시도하세요.', 409)
  return data
}
function durable(file, source, mode = 0o600) {
  const fd = fs.openSync(file, 'wx', mode)
  try { fs.writeFileSync(fd, source); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function revoke(slug, doc) {
  if (!exists(SHARES)) return
  regular(SHARES)
  const all = JSON.parse(fs.readFileSync(SHARES, 'utf8'))
  if (!Array.isArray(all.shares)) throw new DocumentError('공유 링크 목록을 확인해야 합니다.', 500)
  const kept = all.shares.filter(s => s.slug !== slug || s.doc !== doc)
  if (kept.length === all.shares.length) return
  const tmp = SHARES + '.' + randomUUID() + '.tmp'
  try { durable(tmp, JSON.stringify({ ...all, shares: kept }, null, 2)); fs.renameSync(tmp, SHARES) }
  finally { if (exists(tmp)) fs.unlinkSync(tmp) }
}
function reserveHistory(target) {
  const h = historyDir(target)
  if (exists(h)) throw new DocumentError('같은 주소의 이전 버전이 남아 있습니다. 다른 문서 주소를 사용하세요.', 409)
  return h
}
function transferHistory(from, to) {
  const h = historyDir(from)
  if (exists(h)) { fs.renameSync(h, to); return h }
  return null
}
// Exclusive hard-link publication never replaces a destination created by another writer.
function publish(source, target, mode) {
  const tmp = target + '.' + randomUUID() + '.tmp'
  try {
    durable(tmp, source, mode)
    try { fs.linkSync(tmp, target) } catch (e) { if (e.code === 'EEXIST') throw new DocumentError('대상에 같은 이름의 글이 있습니다.', 409); throw e }
  } finally { if (exists(tmp)) fs.unlinkSync(tmp) }
}
export async function moveDocument(slug, doc, targetSlug, expectedRevision) {
  const from = editorDocument(slug, doc), to = destination(targetSlug, doc)
  if (from.file === to.file) throw new DocumentError('현재 프로젝트와 같습니다.')
  return locked([from.file, to.file], async () => {
    const { source } = checkRevision(from, expectedRevision)
    if (exists(to.file)) throw new DocumentError('대상에 같은 이름의 글이 있습니다.', 409)
    const history = reserveHistory(to)
    await previewDocument(to, source) // Relative imports must still work at the new location.
    checkRevision(from, expectedRevision)
    revoke(slug, doc); revoke(targetSlug, doc)
    let oldHistory
    publish(source, to.file, regular(from.file).mode & 0o777)
    try { oldHistory = transferHistory(from, history); fs.unlinkSync(from.file) }
    catch (e) { if (oldHistory) fs.renameSync(history, oldHistory); fs.unlinkSync(to.file); throw e }
    return { ok: true, slug: targetSlug, doc, url: `/p/${encodeURIComponent(targetSlug)}/${encodeURIComponent(doc)}` }
  })
}
const trashBase = create => directory(path.join(ROOT, '.document-trash'), create)
function trashItem(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new DocumentError('잘못된 휴지통 번호입니다.')
  const dir = directory(path.join(trashBase(false), id))
  const manifest = path.join(dir, 'meta.json'), file = path.join(dir, 'source.mdx')
  if (!exists(manifest) || !exists(file)) throw new DocumentError('휴지통에서 글을 찾을 수 없습니다.', 404)
  regular(manifest); regular(file)
  const meta = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  if (meta.id !== id || !valid(meta.slug) || !valid(meta.doc)) throw new DocumentError('휴지통 정보가 올바르지 않습니다.', 500)
  const source = fs.readFileSync(file, 'utf8')
  if (revisionOf(source) !== meta.revision) throw new DocumentError('휴지통 파일이 변경되어 복원하지 않았습니다.', 409)
  return { dir, file, meta, source }
}
export function listTrash() {
  const base = trashBase(false)
  if (!exists(base)) return []
  return fs.readdirSync(base).filter(id => /^[a-f0-9-]{36}$/.test(id)).map(id => {
    const item = trashItem(id)
    return item.meta
  }).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}
export async function trashDocument(slug, doc, expectedRevision, actor) {
  const target = editorDocument(slug, doc)
  return locked([target.file], () => {
    const { source, revision } = checkRevision(target, expectedRevision)
    const id = randomUUID(), dir = path.join(trashBase(true), id)
    fs.mkdirSync(dir, { mode: 0o700 })
    const meta = { id, slug, doc, title: parseDocMeta(source).title || doc, revision, deletedAt: new Date().toISOString(), actor }
    let oldHistory
    try {
      durable(path.join(dir, 'source.mdx'), source)
      durable(path.join(dir, 'meta.json'), JSON.stringify(meta))
      revoke(slug, doc)
      oldHistory = transferHistory(target, path.join(dir, 'history'))
      fs.unlinkSync(target.file)
    } catch (e) {
      if (oldHistory) fs.renameSync(path.join(dir, 'history'), oldHistory)
      fs.rmSync(dir, { recursive: true, force: true }); throw e
    }
    return { ok: true, item: meta }
  })
}
export async function restoreTrashedDocument(id) {
  const item = trashItem(id), to = destination(item.meta.slug, item.meta.doc)
  return locked([item.dir, to.file], async () => {
    if (exists(to.file)) throw new DocumentError('원래 위치에 같은 이름의 글이 있습니다. 덮어쓰지 않았습니다.', 409)
    const history = reserveHistory(to)
    await previewDocument(to, item.source)
    // Check the item again after async compilation; concurrent restore cannot replay it.
    trashItem(id)
    revoke(to.slug, to.doc)
    let moved = false
    publish(item.source, to.file, 0o600)
    try {
      if (exists(path.join(item.dir, 'history'))) { fs.renameSync(path.join(item.dir, 'history'), history); moved = true }
      // Keep the only durable copy until both source and history are restored.
      fs.unlinkSync(item.file)
    } catch (e) { if (moved) fs.renameSync(history, path.join(item.dir, 'history')); fs.unlinkSync(to.file); throw e }
    fs.unlinkSync(path.join(item.dir, 'meta.json')); fs.rmdirSync(item.dir)
    return { ok: true, slug: to.slug, doc: to.doc, url: `/p/${encodeURIComponent(to.slug)}/${encodeURIComponent(to.doc)}` }
  })
}
