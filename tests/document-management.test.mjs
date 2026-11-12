import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moa-management-test-')))
Object.assign(process.env, { MOA_CONTENT_ROOT: root, MOA_BROWSE_ROOT: path.join(root, 'projects'), MOA_SECRET: crypto.randomBytes(32).toString('hex'), MOA_PUBLIC_ORIGIN: 'https://moa.test', MOA_NO_AUTH: '0' })
for (const slug of ['a', 'b']) fs.mkdirSync(path.join(root, 'projects', slug), { recursive: true })
const editor = await import('../lib/document-editor.mjs')
const management = await import('../lib/document-management.mjs')
const { documentEditorAPI: api } = await import('../lib/document-editor-api.mjs')
const users = await import('../lib/users.mjs'), auth = await import('../lib/auth.mjs')
const admin = users.createUser({ email: 'admin@management.test', name: 'Admin', password: 'synthetic-test', role: 'admin' }).user
const member = users.createUser({ email: 'member@management.test', name: 'Member', password: 'synthetic-test', projects: ['a'] }).user
const source = "export const title = '보고서'\nexport const group = '운영'\n\n# Original\n"
const put = (doc, slug = 'a', text = source) => { fs.writeFileSync(path.join(root, 'projects', slug, doc + '.mdx'), text); return editor.editorDocument(slug, doc) }
function req(body, user = admin, origin = 'https://moa.test', method = 'POST') {
  return new Request('https://moa.test/api/doc/manage', { method, headers: { ...(user ? { cookie: 'moa_user=' + auth.mintUserCookie(user) } : {}), origin, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
}
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
test('management read and every mutation require an active admin; cross-origin writes fail', async () => {
  for (const user of [null, member]) for (const action of ['move', 'trash', 'restore']) assert.equal((await api(req({ action }, user), 'manage')).status, user ? 403 : 401)
  assert.equal((await api(req(null, member, 'https://moa.test', 'GET'), 'manage')).status, 403)
  assert.equal((await api(req({ action: 'trash' }, admin, 'https://evil.test'), 'manage')).status, 403)
  users.setUserDisabled(admin.id, true)
  assert.equal((await api(req(null, admin, 'https://moa.test', 'GET'), 'manage')).status, 401)
  users.setUserDisabled(admin.id, false)
})
test('move preserves body, previous versions and revokes old shares', async () => {
  let target = put('move-me')
  const changed = source + '\nUpdated body\n'
  await editor.saveDocument(target, { source: changed, expectedRevision: editor.revisionOf(source), actor: 'test' })
  fs.writeFileSync(path.join(root, 'shares.json'), JSON.stringify({ shares: [{ token: 'synthetic-share', slug: 'a', doc: 'move-me' }] }))
  const result = await management.moveDocument('a', 'move-me', 'b', editor.revisionOf(changed))
  assert.equal(result.url, '/p/b/move-me')
  assert.equal(fs.existsSync(target.file), false)
  target = editor.editorDocument('b', 'move-me')
  assert.equal(editor.readDocument(target).source, changed)
  assert.equal(editor.documentHistory(target).length, 2)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'shares.json'))).shares, [])
})
test('same-name destination and stale revisions never overwrite either file', async () => {
  const from = put('conflict'), to = put('conflict', 'b', '# Other')
  await assert.rejects(management.moveDocument('a', 'conflict', 'b', editor.revisionOf(source)), e => e.status === 409)
  await assert.rejects(management.trashDocument('a', 'conflict', '0'.repeat(64), 'test'), e => e.status === 409)
  assert.equal(fs.readFileSync(from.file, 'utf8'), source); assert.equal(fs.readFileSync(to.file, 'utf8'), '# Other')
})
test('trash removes from index, retains versions and restores byte-for-byte', async () => {
  const target = put('trash-me')
  const changed = source + '\nBefore deletion'
  await editor.saveDocument(target, { source: changed, expectedRevision: editor.revisionOf(source), actor: 'test' })
  const result = await management.trashDocument('a', 'trash-me', editor.revisionOf(changed), 'Admin')
  assert.equal(fs.existsSync(target.file), false)
  assert.ok(management.listTrash().some(i => i.id === result.item.id))
  const { buildIndex } = await import('../lib/content.mjs')
  assert.equal(buildIndex().projects.find(p => p.slug === 'a').docs.some(d => d.slug === 'trash-me'), false)
  await management.restoreTrashedDocument(result.item.id)
  assert.equal(fs.readFileSync(target.file, 'utf8'), changed)
  assert.equal(editor.documentHistory(editor.editorDocument('a', 'trash-me')).length, 2)
  assert.equal(management.listTrash().some(i => i.id === result.item.id), false)
})
test('restore collision leaves the newer file and trash intact', async () => {
  put('restore-conflict')
  const { item } = await management.trashDocument('a', 'restore-conflict', editor.revisionOf(source), 'test')
  put('restore-conflict', 'a', '# Newer')
  await assert.rejects(management.restoreTrashedDocument(item.id), e => e.status === 409)
  assert.equal(fs.readFileSync(path.join(root, 'projects/a/restore-conflict.mdx'), 'utf8'), '# Newer')
  assert.ok(management.listTrash().find(i => i.id === item.id))
})
test('path traversal, document symlinks and external project escape are rejected', async () => {
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'outside.mdx'), source)
  fs.symlinkSync(path.join(outside, 'outside.mdx'), path.join(root, 'projects/a/symlink.mdx'))
  fs.symlinkSync(outside, path.join(root, 'projects/escape'))
  put('safe')
  await assert.rejects(management.trashDocument('a', '../outside', editor.revisionOf(source), 'test'))
  await assert.rejects(management.trashDocument('a', 'symlink', editor.revisionOf(source), 'test'), e => e.status === 403)
  await assert.rejects(management.moveDocument('a', 'safe', 'escape', editor.revisionOf(source)), e => e.status === 403)
  assert.equal(fs.readFileSync(path.join(outside, 'outside.mdx'), 'utf8'), source)
})
test('moving a document with broken relative dependencies leaves original untouched', async () => {
  const text = "import Card from './only-here.jsx'\n\n<Card/>\n"
  fs.writeFileSync(path.join(root, 'projects/a/only-here.jsx'), 'export default function Card(){return <p>Local</p>}')
  const target = put('local-import', 'a', text)
  await assert.rejects(management.moveDocument('a', 'local-import', 'b', editor.revisionOf(text)), e => e.status === 422)
  assert.equal(fs.readFileSync(target.file, 'utf8'), text)
  assert.equal(fs.existsSync(path.join(root, 'projects/b/local-import.mdx')), false)
})
test('API move/trash/list/restore returns correct results and does not expose source in trash listing', async () => {
  put('api-doc')
  const r = await api(req({ action: 'trash', slug: 'a', doc: 'api-doc', expectedRevision: editor.revisionOf(source) }), 'manage')
  assert.equal(r.status, 200); const { item } = await r.json()
  const listed = await (await api(req(null, admin, 'https://moa.test', 'GET'), 'manage')).json()
  assert.ok(listed.items.find(i => i.id === item.id)); assert.equal(JSON.stringify(listed).includes('# Original'), false)
  assert.equal((await api(req({ action: 'restore', id: item.id }), 'manage')).status, 200)
  assert.equal((await api(req({ action: 'move', slug: 'a', doc: 'api-doc', targetSlug: 'b', expectedRevision: editor.revisionOf(source) }), 'manage')).status, 200)
})
test('failed source removal rolls back published file and version-history relocation', async t => {
  const target = put('io-failure'), changed = source + '\nBefore I/O failure'
  await editor.saveDocument(target, { source: changed, expectedRevision: editor.revisionOf(source), actor: 'test' })
  const unlink = fs.unlinkSync
  t.mock.method(fs, 'unlinkSync', file => { if (file === target.file) throw new Error('simulated filesystem failure'); return unlink(file) })
  await assert.rejects(management.moveDocument('a', 'io-failure', 'b', editor.revisionOf(changed)))
  assert.equal(fs.readFileSync(target.file, 'utf8'), changed)
  assert.equal(fs.existsSync(path.join(root, 'projects/b/io-failure.mdx')), false)
  assert.equal(editor.documentHistory(target).length, 2)
  await assert.rejects(management.trashDocument('a', 'io-failure', editor.revisionOf(changed), 'test'))
  assert.equal(fs.readFileSync(target.file, 'utf8'), changed)
  assert.equal(editor.documentHistory(target).length, 2)
  assert.equal(management.listTrash().some(i => i.doc === 'io-failure'), false)
})
