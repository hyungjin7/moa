import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moa-llm-')))
process.env.MOA_CONTENT_ROOT = dir
process.env.MOA_BROWSE_ROOT = dir
process.env.OPENAI_BASE_URL = 'http://llm.internal/api/v1'
process.env.LLM_PROVIDER = 'custom'
const { completion, projectContext, llmChat, llmSessions, llmSession } = await import('../lib/llm.mjs')
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
const ok = text => Response.json({ choices: [{ message: { content: text } }] })
test('OpenAI wire format uses configured endpoint, optional key and model', async () => {
 process.env.OPENAI_API_KEY = 'synthetic-key'; process.env.OPENAI_MODEL = 'local-test'
 const out = await completion([{ role: 'user', content: 'hello' }], undefined, async (url, options) => {
  assert.equal(url, 'http://llm.internal/api/v1/chat/completions')
  assert.equal(options.headers.Authorization, 'Bearer synthetic-key')
  assert.equal(JSON.parse(options.body).model, 'local-test')
  return ok('answer')
 }); assert.equal(out, 'answer'); delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_MODEL
})
test('queue polling stays on configured origin and propagates upstream error', async () => {
 process.env.MOA_LLM_PROXY = '1'; let count = 0
 const mock = async (url, options) => {
  if (!count++) { assert.equal(JSON.parse(options.body).priority, 'interactive'); return Response.json({job_id:'safe-id', poll:'http://evil.example/'}, {status:202}) }
  assert.equal(url, 'http://llm.internal/api/v1/agents/llm/jobs/safe-id')
  return Response.json({status:'done', status_code:503, result:{error:{message:'no'}}})
 }
 await assert.rejects(completion([], undefined, mock), /503/); delete process.env.MOA_LLM_PROXY
})
test('invalid or empty LLM response is failure', async () => {
 await assert.rejects(completion([], undefined, async () => Response.json({error:'bad'}, {status:500})), /failed/)
 await assert.rejects(completion([], undefined, async () => ok('')), /no answer/)
})
test('document context bounds data, excludes symlink and outside folder', () => {
 fs.writeFileSync(path.join(dir,'guide.mdx'), 'hello '.repeat(3000)); fs.symlinkSync('/etc/passwd',path.join(dir,'secret.md'))
 const text = projectContext(dir); assert.ok(text.length <=12000); assert.ok(!text.includes('root:'))
 assert.throws(() => projectContext('/etc'), /outside/)
})
test('chat persists successful conversation, restores history, isolates project and rejects duplicate run', async () => {
 const original = global.fetch; let release; global.fetch = async () => { await new Promise(r => release=r); return ok('내부 응답') }
 try {
  const req = new Request('http://localhost/api/chat'), proj={slug:'guide',title:'Guide',path:dir}
  const response = llmChat(req,proj,'질문'); const result = response.text(); await new Promise(r=>setImmediate(r)); release(); const events=(await result).trim().split('\n').map(JSON.parse)
  assert.ok(events.some(e=>e.type==='assistant')); const id=events.find(e=>e.type==='result').session_id
  assert.equal(llmSessions('guide').length,1); assert.equal(llmSession('other',id),undefined)
  assert.equal(fs.statSync(path.join(dir,'llm-sessions.json')).mode & 0o777,0o600)
  const resumed=llmChat(req,proj,'후속',id); const resumedText=resumed.text(); await new Promise(r=>setImmediate(r))
  assert.equal(llmChat(req,proj,'중복',id).status,409); release(); await resumedText
  assert.equal(llmSession('guide',id).messages.length,4)
  assert.equal(llmChat(req,proj,'bad','missing').status,400)
 } finally {global.fetch=original}
})
