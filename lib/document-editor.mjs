// Admin document editing. Single MOA process; revisions also detect external writers.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { ROOT, ALLOW } from './paths.mjs'
import { buildIndex, docPath } from './content.mjs'
import { bundleSource } from './bundle.mjs'
export const SOURCE_LIMIT = 512 * 1024
export const HISTORY_LIMIT = 50
export class DocumentError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}
export const revisionOf = source => createHash('sha256').update(source).digest('hex')
const within = (file, root) => file === root || file.startsWith(root + path.sep)
const lockKey = Symbol.for('moa.document-editor.locks')
const locks = globalThis[lockKey] || (globalThis[lockKey] = new Set())
const regular = file => { const s = fs.lstatSync(file); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new DocumentError('일반 문서 파일만 편집할 수 있습니다.', 403); return s }
export function editorDocument(slug, doc) {
  if (typeof slug !== 'string' || typeof doc !== 'string' || !/^[\w.\-가-힣 ]+$/.test(slug) || !/^[\w.\-가-힣 ]+$/.test(doc) || [slug, doc].some(s => s === '.' || s === '..')) throw new DocumentError('잘못된 문서 주소입니다.')
  const project = buildIndex().projects.find(p => p.slug === slug)
  if (!project || !project.docs.some(d => d.slug === doc)) throw new DocumentError('문서를 찾을 수 없습니다.', 404)
  if (project.demo) throw new DocumentError('예시 문서는 편집할 수 없습니다.', 403)
  const root = fs.realpathSync(project.path || path.join(ROOT, project.root, slug))
  if (!within(root, fs.realpathSync(ALLOW))) throw new DocumentError('허용된 프로젝트 폴더 밖입니다.', 403)
  const named = path.join(root, doc + '.mdx')
  regular(named)
  const file = docPath(slug, doc)
  if (!file || !within(file, root) || file !== fs.realpathSync(named)) throw new DocumentError('프로젝트 밖의 파일은 편집할 수 없습니다.', 403)
  return { slug, doc, file }
}
function atomic(file, content, mode = 0o600) {
  const tmp = file + '.' + randomUUID() + '.tmp'
  let fd
  try {
    fd = fs.openSync(tmp, 'wx', mode); fs.writeFileSync(fd, content); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
    fs.renameSync(tmp, file)
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(tmp) } catch {} }
}
export function historyDir(target, create = false) {
  const base = path.join(ROOT, '.document-history')
  const dir = path.join(base, revisionOf(JSON.stringify([target.slug, target.doc])))
  for (const p of [base, dir]) {
    if (fs.existsSync(p)) { const s = fs.lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink()) throw new DocumentError('버전 저장소 경로가 올바르지 않습니다.', 500) }
    else if (create) fs.mkdirSync(p, { mode: 0o700 })
  }
  return dir
}
function readIndex(target) {
  const dir = historyDir(target)
  if (!fs.existsSync(path.join(dir, 'index.json'))) return []
  regular(path.join(dir, 'index.json'))
  const rows = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
  if (!Array.isArray(rows)) throw new DocumentError('버전 목록이 손상되었습니다.', 500)
  return rows
}
function snapshot(target, source, actor, reason, restoredFrom) {
  const rows = readIndex(target), hash = revisionOf(source)
  if (rows.at(-1)?.revision === hash) return rows
  const dir = historyDir(target, true), id = randomUUID()
  const row = { id, revision: hash, createdAt: new Date().toISOString(), bytes: Buffer.byteLength(source), actor, reason, ...(restoredFrom ? { restoredFrom } : {}) }
  atomic(path.join(dir, id + '.mdx'), source)
  try { atomic(path.join(dir, 'index.json'), JSON.stringify([...rows, row].slice(-HISTORY_LIMIT))) }
  catch (e) { fs.unlinkSync(path.join(dir, id + '.mdx')); throw e }
  // Prune only after the durable new index exists. Never prune the document itself.
  for (const old of rows.slice(0, Math.max(0, rows.length + 1 - HISTORY_LIMIT))) {
    if (/^[a-f0-9-]{36}$/.test(old.id)) { try { fs.unlinkSync(path.join(dir, old.id + '.mdx')) } catch {} }
  }
  return [...rows, row].slice(-HISTORY_LIMIT)
}
export function readDocument(target) {
  regular(target.file)
  if (fs.statSync(target.file).size > SOURCE_LIMIT) throw new DocumentError('512KiB보다 큰 문서는 웹 편집을 지원하지 않습니다.', 413)
  const source = fs.readFileSync(target.file, 'utf8')
  return { source, revision: revisionOf(source) }
}
export function documentHistory(target) {
  const { revision } = readDocument(target)
  let found = false
  return readIndex(target).toReversed().map(row => { const current = !found && row.revision === revision; if (current) found = true; return { ...row, current } })
}
export function historicalSource(target, id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new DocumentError('잘못된 버전 번호입니다.')
  const row = readIndex(target).find(v => v.id === id)
  if (!row) throw new DocumentError('버전을 찾을 수 없습니다.', 404)
  const file = path.join(historyDir(target), id + '.mdx'); regular(file)
  const source = fs.readFileSync(file, 'utf8')
  if (revisionOf(source) !== row.revision) throw new DocumentError('버전 파일이 손상되어 복원하지 않았습니다.', 500)
  return { source, version: row }
}
export async function previewDocument(target, source) {
  if (typeof source !== 'string') throw new DocumentError('본문은 문자열이어야 합니다.')
  if (Buffer.byteLength(source) > SOURCE_LIMIT) throw new DocumentError('문서 크기는 최대 512KiB입니다.', 413)
  const result = await bundleSource(target.file, source)
  if (result.error) throw new DocumentError(result.error, 422)
  return result
}
export async function saveDocument(target, { source, expectedRevision, actor = 'Owner', reason = 'save', restoredFrom }) {
  if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw new DocumentError('원본 버전이 필요합니다.')
  if (locks.has(target.file)) throw new DocumentError('다른 저장이 진행 중입니다. 잠시 후 다시 시도하세요.', 409)
  locks.add(target.file)
  try {
    const before = readDocument(target)
    if (before.revision !== expectedRevision) throw new DocumentError('다른 곳에서 문서가 변경됐습니다. 작성한 내용을 복사한 뒤 최신 문서를 다시 불러오세요.', 409)
    await previewDocument(target, source)
    // Bundling yields: an agent or another metadata action could have changed the file.
    if (readDocument(target).revision !== expectedRevision) throw new DocumentError('문서가 변경되어 덮어쓰지 않았습니다. 최신 문서를 다시 불러오세요.', 409)
    if (source === before.source) return { ...before, unchanged: true }
    snapshot(target, before.source, '기존 문서', 'checkpoint')
    const mode = regular(target.file).mode & 0o777
    atomic(target.file, source, mode)
    try { snapshot(target, source, actor, reason, restoredFrom) }
    catch (e) { atomic(target.file, before.source, mode); throw e }
    return { source, revision: revisionOf(source), unchanged: false }
  } finally { locks.delete(target.file) }
}
export async function restoreDocument(target, { versionId, expectedRevision, actor }) {
  const { source } = historicalSource(target, versionId)
  return saveDocument(target, { source, expectedRevision, actor, reason: 'restore', restoredFrom: versionId })
}
