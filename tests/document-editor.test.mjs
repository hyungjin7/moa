import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsxRuntime from 'react/jsx-runtime'
import * as mdxReact from '@mdx-js/react'
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moa-editor-test-')))
Object.assign(process.env, { MOA_CONTENT_ROOT: root, MOA_BROWSE_ROOT: path.join(root, 'projects'), MOA_SECRET: crypto.randomBytes(32).toString('hex'), MOA_PUBLIC_ORIGIN: 'https://moa.test', MOA_NO_AUTH: '0' })
fs.mkdirSync(path.join(root, 'projects', 'notes'), { recursive: true })
const file = path.join(root, 'projects', 'notes', 'report.mdx')
const original = "export const title = '원본 보고서'\nexport const group = '운영'\n\n# 원본\n\n| 항목 | 결과 |\n| --- | --- |\n| 기능 | 확인 |\n\n<Callout>기존 MDX 유지</Callout>\n"
fs.writeFileSync(file, original)
const auth = await import('../lib/auth.mjs'), users = await import('../lib/users.mjs')
const editor = await import('../lib/document-editor.mjs'), { documentEditorAPI: api } = await import('../lib/document-editor-api.mjs')
const metadata = await import('../app/api/doc/update/route.js')
const admin = users.createUser({ email: 'admin@editor.test', name: '편집 관리자', password: 'synthetic-password', role: 'admin' }).user
const member = users.createUser({ email: 'member@editor.test', name: '일반 회원', password: 'synthetic-password', projects: ['notes'] }).user
const cookie = user => 'moa_user=' + auth.mintUserCookie(user)
function req(action, body, user = admin, origin = 'https://moa.test') {
 const method = ['read', 'history'].includes(action) ? 'GET' : 'POST'
 const q = new URLSearchParams({ slug: 'notes', doc: 'report', ...(body && method === 'GET' ? body : {}) })
 return new Request('https://moa.test/api/doc/' + action + '?' + q, { method, headers: { ...(user ? {cookie:cookie(user)} : {}), origin, 'Content-Type':'application/json' }, ...(method==='POST'?{body:JSON.stringify({slug:'notes',doc:'report',...body})}:{}) })
}
let target = editor.editorDocument('notes', 'report')
test.after(() => fs.rmSync(root, { recursive:true,force:true }))
test('only active administrators can read, preview, save, view history or restore', async () => {
 for(const action of ['read','preview','save','history','restore']) {
  assert.equal((await api(req(action,{},null),action)).status,401)
  assert.equal((await api(req(action,{},member),action)).status,403)
 }
 users.setUserDisabled(admin.id,true);assert.equal((await api(req('read'), 'read')).status,401);users.setUserDisabled(admin.id,false)
})
test('preview uses unsaved MDX and creates no version or file changes', async () => {
 const r=await api(req('preview',{source:original+'\n## 미리보기 전용\n'}),'preview')
 assert.equal(r.status,200)
 const mod={exports:{}};new Function('require','module','exports',(await r.json()).code)(id=>({'react/jsx-runtime':jsxRuntime,'@mdx-js/react':mdxReact}[id]),mod,mod.exports)
 const html=renderToStaticMarkup(React.createElement(mod.exports.default,{components:{Callout:p=>React.createElement('aside',p)}}))
 assert.match(html,/미리보기 전용/);assert.match(html,/<table>/);assert.match(html,/<aside>기존 MDX 유지<\/aside>/)
 assert.equal(fs.readFileSync(file,'utf8'),original);assert.deepEqual(editor.documentHistory(target),[])
})
test('preview preserves relative component imports', async () => {
 fs.writeFileSync(path.join(root,'projects','notes','card.jsx'),"export default function Card(){return <aside>Imported component</aside>}")
 const result=await editor.previewDocument(target,"import Card from './card.jsx'\n\n# Imported\n\n<Card/>\n")
 const mod={exports:{}};new Function('require','module','exports',result.code)(id=>({'react/jsx-runtime':jsxRuntime,'@mdx-js/react':mdxReact}[id]),mod,mod.exports)
 assert.match(renderToStaticMarkup(React.createElement(mod.exports.default)),/Imported component/)
})
test('origin, malformed input and source size are guarded', async () => {
 assert.equal((await api(req('save',{source:original},admin,'https://evil.test'),'save')).status,403)
 assert.equal((await api(new Request('https://moa.test/api/doc/save',{method:'POST',headers:{cookie:cookie(admin),origin:'https://moa.test','content-type':'application/json'},body:'null'}),'save')).status,400)
 assert.equal((await api(req('preview',{source:'한'.repeat(200000)}),'preview')).status,413)
})
test('local host validation uses the browser Host while production uses configured origin', async () => {
 const origin=process.env.MOA_PUBLIC_ORIGIN;delete process.env.MOA_PUBLIC_ORIGIN
 try {
  const r=new Request('http://localhost:5001/api/doc/preview',{method:'POST',headers:{cookie:cookie(admin),host:'127.0.0.1:5001',origin:'http://127.0.0.1:5001','Content-Type':'application/json'},body:JSON.stringify({slug:'notes',doc:'report',source:'# Local preview'})})
  assert.equal((await api(r,'preview')).status,200)
 } finally {process.env.MOA_PUBLIC_ORIGIN=origin}
})
test('save preserves the initial source and creates an attributed version; unchanged save is a no-op', async () => {
 const before=editor.readDocument(target)
 const source=original.replace('# 원본','# 수정된 문서')
 const r=await api(req('save',{source,expectedRevision:before.revision}),'save');assert.equal(r.status,200)
 assert.equal(fs.readFileSync(file,'utf8'),source)
 const versions=editor.documentHistory(target);assert.equal(versions.length,2);assert.equal(versions[0].actor,'편집 관리자');assert.equal(versions[0].current,true)
 assert.equal(editor.historicalSource(target,versions[1].id).source,original)
 await editor.saveDocument(target,{source,expectedRevision:editor.readDocument(target).revision});assert.equal(editor.documentHistory(target).length,2)
})
test('stale saves and invalid MDX leave the current file and versions intact', async () => {
 const before=editor.readDocument(target), count=editor.documentHistory(target).length
 assert.equal((await api(req('save',{source:'# Lost update',expectedRevision:editor.revisionOf(original)}),'save')).status,409)
 assert.equal((await api(req('save',{source:'<Broken',expectedRevision:before.revision}),'save')).status,422)
 assert.deepEqual(editor.readDocument(target),before);assert.equal(editor.documentHistory(target).length,count)
})
test('restoring records a new version and preserves the content from before restoration', async () => {
 const before=editor.readDocument(target), first=editor.documentHistory(target).at(-1)
 const r=await api(req('restore',{versionId:first.id,expectedRevision:before.revision}),'restore');assert.equal(r.status,200)
 assert.equal(editor.readDocument(target).source,original)
 const h=editor.documentHistory(target);assert.equal(h[0].reason,'restore');assert.equal(h[0].restoredFrom,first.id)
 assert.equal(editor.historicalSource(target,h[1].id).source,before.source)
 assert.equal(h.filter(v=>v.current).length,1)
})
test('metadata edits join the same version history and stale editor revisions cannot overwrite them', async () => {
 const before=editor.readDocument(target)
 const r=await metadata.POST(req('save',{title:'새 제목'}));assert.equal(r.status,200)
 assert.equal(editor.documentHistory(target)[0].reason,'metadata')
 await assert.rejects(editor.saveDocument(target,{source:original,expectedRevision:before.revision}),e=>e.status===409)
})
test('simultaneous saves and agent file changes are detected', async () => {
 const before=editor.readDocument(target)
 const twin=await import('../lib/document-editor.mjs?separate-route-bundle')
 const pending=editor.saveDocument(target,{source:before.source+'\n첫 저장\n',expectedRevision:before.revision})
 await assert.rejects(twin.saveDocument(target,{source:'# duplicate',expectedRevision:before.revision}),e=>e.status===409)
 await pending
 const current=editor.readDocument(target)
 const race=editor.saveDocument(target,{source:current.source+'\n웹 편집\n',expectedRevision:current.revision})
 fs.writeFileSync(file,current.source+'\n에이전트 변경\n')
 await assert.rejects(race,e=>e.status===409);assert.match(fs.readFileSync(file,'utf8'),/에이전트 변경/)
})
test('traversal, file symlink, external folder, demo and foreign version IDs are rejected', async () => {
 assert.throws(()=>editor.editorDocument('..','report'),e=>e.status===400)
 const outside=path.join(root,'private.mdx');fs.writeFileSync(outside,'# private')
 fs.symlinkSync(outside,path.join(root,'projects','notes','escape.mdx'));assert.throws(()=>editor.editorDocument('notes','escape'),e=>e.status===403)
 fs.mkdirSync(path.join(root,'outside'));fs.writeFileSync(path.join(root,'outside','doc.mdx'),'# outside')
 fs.writeFileSync(path.join(root,'registry.json'),JSON.stringify({projects:[{slug:'external',path:path.join(root,'outside')}]}))
 fs.symlinkSync(path.join(root,'outside'),path.join(root,'projects','external'));assert.throws(()=>editor.editorDocument('external','doc'),e=>e.status===403)
 fs.mkdirSync(path.join(root,'demo','projects','demo'),{recursive:true});fs.writeFileSync(path.join(root,'demo','projects','demo','test.mdx'),'# demo');assert.throws(()=>editor.editorDocument('demo','test'),e=>e.status===403)
 fs.writeFileSync(path.join(root,'projects','notes','another.mdx'),'# Other')
 const other=editor.editorDocument('notes','another');assert.throws(()=>editor.historicalSource(other,editor.documentHistory(target)[0].id),e=>e.status===404)
})
test('history corruption blocks restoration without touching the source', async () => {
 const version=editor.documentHistory(target).at(-1),before=editor.readDocument(target)
 const key=editor.revisionOf(JSON.stringify(['notes','report'])),p=path.join(root,'.document-history',key,version.id+'.mdx')
 const saved=fs.readFileSync(p);fs.writeFileSync(p,'corrupt')
 await assert.rejects(editor.restoreDocument(target,{versionId:version.id,expectedRevision:before.revision}),e=>e.status===500)
 assert.deepEqual(editor.readDocument(target),before);fs.writeFileSync(p,saved)
})
test('retention keeps at most 50 snapshots and version files with private permissions', async () => {
 for(let i=0;i<52;i++){const before=editor.readDocument(target);await editor.saveDocument(target,{source:'# Retention '+i,expectedRevision:before.revision})}
 const h=editor.documentHistory(target);assert.equal(h.length,50)
 const dir=path.join(root,'.document-history',editor.revisionOf(JSON.stringify(['notes','report'])))
 assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.mdx')).length,50)
 assert.equal(fs.statSync(dir).mode&0o777,0o700);assert.equal(fs.statSync(path.join(dir,'index.json')).mode&0o777,0o600)
})
