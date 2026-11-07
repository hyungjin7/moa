import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import crypto from 'node:crypto'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
const tmp = process.env.MOA_TEST_TLS_DIR
if (!tmp) throw new Error('Use npm run test:oidc for an isolated TLS test server')
const key = await generateKeyPair('RS256'), attacker = await generateKeyPair('RS256')
const jwk = { ...await exportJWK(key.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }
let issuer
const codes = new Map()
const server = https.createServer({ key: fs.readFileSync(path.join(tmp, 'key.pem')), cert: fs.readFileSync(path.join(tmp, 'cert.pem')) }, async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks', end_session_endpoint: issuer + '/logout', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'] }))
  if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }))
  if (req.url === '/token') {
    let body = ''; for await (const chunk of req) body += chunk
    const params = new URLSearchParams(body), code = codes.get(params.get('code'))
    codes.delete(params.get('code'))
    if (!code || params.get('client_secret') !== 'fixture-client-secret' || crypto.createHash('sha256').update(params.get('code_verifier') || '').digest('base64url') !== code.challenge) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant' })) }
    const token = await new SignJWT({ sub: code.sub || 'subject-1', nonce: code.badNonce ? 'wrong' : code.nonce, email: code.email || 'member@example.test', email_verified: true, name: 'Fixture member' })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).setIssuer(code.badIssuer ? issuer + '/wrong' : issuer).setAudience(code.badAudience ? 'another-client' : 'moa-web').setIssuedAt().setExpirationTime(code.expired ? '-1m' : '5m').sign(code.badSignature ? attacker.privateKey : key.privateKey)
    return res.end(JSON.stringify({ access_token: 'fixture-access', token_type: 'Bearer', expires_in: 300, id_token: token }))
  }
  res.statusCode = 404; res.end('{}')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
issuer = `https://127.0.0.1:${server.address().port}`
Object.assign(process.env, { MOA_SECRET: crypto.randomBytes(32).toString('hex'), MOA_CONTENT_ROOT: path.join(tmp, 'data'), MOA_PUBLIC_ORIGIN: 'https://moa.example.test', MOA_OIDC_ENABLED: '1', MOA_OIDC_ISSUER: issuer, MOA_OIDC_CLIENT_ID: 'moa-web', MOA_OIDC_CLIENT_SECRET: 'fixture-client-secret' })
fs.mkdirSync(process.env.MOA_CONTENT_ROOT)
const auth = await import('../../lib/auth.mjs'), users = await import('../../lib/users.mjs'), store = await import('../../lib/oidc-store.mjs'), oidc = await import('../../lib/oidc.mjs'), api = await import('../../lib/api.mjs')
const adminRoute = await import('../../app/api/users/oidc/route.js')
const member = users.createUser({ email: 'member@example.test', name: 'Member', password: 'fixture-password', projects: ['allowed-project'] }).user
const admin = users.createUser({ email: 'admin@example.test', name: 'Admin', password: 'fixture-password', role: 'admin' }).user
function request(url, cookie, method = 'GET', body, origin = 'https://moa.example.test') {
  return new Request(url, { method, headers: { ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { origin, 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
}
async function flow(overrides = {}, next = '/p/allowed-project/report') {
  const begin = await oidc.begin(request('https://moa.example.test/api/oidc/login?next=' + encodeURIComponent(next)))
  const target = new URL(begin.headers.get('location'))
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256')
  const cookie = begin.headers.getSetCookie()[0].split(';')[0]
  const code = crypto.randomBytes(12).toString('hex')
  codes.set(code, { nonce: target.searchParams.get('nonce'), challenge: target.searchParams.get('code_challenge'), ...overrides })
  const callback = 'https://moa.example.test/api/oidc/callback?' + new URLSearchParams({ state: target.searchParams.get('state'), code, iss: issuer })
  return { cookie, callback, state: target.searchParams.get('state'), finish: () => oidc.finish(request(callback, cookie)) }
}
let nativeCookie = 'moa_user=' + auth.mintUserCookie(admin), ssoCookie

test('native password and session remain valid without an OIDC session', () => {
  assert.equal(users.verifyUser(member.email, 'fixture-password').id, member.id)
  assert.equal(api.getAuth(request('https://moa.example.test/api/me', nativeCookie)).role, 'admin')
})
test('first SSO with same email never auto-links or grants access', async () => {
  const response = await (await flow()).finish()
  assert.match(response.headers.get('location'), /msg=/)
  assert.equal(store.readStore().bindings.length, 0)
  assert.equal(store.readStore().sessions.length, 0)
  assert.equal(store.readStore().pending.length, 1)
})
test('admin approval enforces origin, role and explicit local account', async () => {
  const pending = store.readStore().pending[0]
  const body = { action: 'bind', requestId: pending.id, userId: member.id }
  const url = 'https://moa.example.test/api/users/oidc'
  assert.equal((await adminRoute.POST(request(url, nativeCookie, 'POST', body, 'https://evil.example.test'))).status, 403)
  assert.equal((await adminRoute.POST(request(url, 'moa_user=' + auth.mintUserCookie(member), 'POST', body))).status, 403)
  assert.equal((await adminRoute.POST(request(url, nativeCookie, 'POST', body))).status, 200)
})
test('linked identity gets local member role, project access and server-bound session', async () => {
  const response = await (await flow()).finish()
  assert.equal(response.headers.get('location'), 'https://moa.example.test/p/allowed-project/report')
  ssoCookie = response.headers.getSetCookie().find(c => c.startsWith('moa_user=') && !c.startsWith('moa_user=;')).split(';')[0]
  assert.ok(response.headers.getSetCookie().some(c => c.includes('Secure')))
  const user = api.getAuth(request('https://moa.example.test/api/me', ssoCookie))
  assert.equal(user.role, 'member'); assert.deepEqual(user.user.projects, ['allowed-project'])
  assert.equal(api.guardAdmin(request('https://moa.example.test/api/users', ssoCookie)).status, 403)
  assert.ok(!JSON.stringify(store.readStore().sessions).includes('fixture-access'))
  assert.ok(!store.readStore().sessions[0].idToken.startsWith('eyJ'))
})
test('disabled local account blocks SSO and existing sessions immediately', async () => {
  users.setUserDisabled(member.id, true)
  assert.equal(api.getAuth(request('https://moa.example.test/api/me', ssoCookie)), null)
  await assert.rejects((await flow()).finish)
  users.setUserDisabled(member.id, false)
})
for (const option of ['badNonce', 'badAudience', 'badIssuer', 'badSignature', 'expired']) test('rejects ' + option + ' ID token', async () => { await assert.rejects((await flow({ [option]: true })).finish) })
test('state/browser mismatch and replay do not establish a session', async () => {
  const f = await flow()
  await assert.rejects(() => oidc.finish(request(f.callback, 'moa_oidc_tx=another-browser')))
  await f.finish()
  await assert.rejects(f.finish)
})
test('external, protocol-relative and backslash return URLs cannot leave MOA', () => {
  for (const value of ['https://evil.test', '//evil.test', '/\\evil.test', '/api/users', '/login']) assert.equal(oidc.safeNext(value), '/')
})
test('logout revokes server session before provider redirect', async () => {
  const response = await (await flow()).finish()
  const cookie = response.headers.getSetCookie().find(c => c.startsWith('moa_user=') && !c.startsWith('moa_user=;')).split(';')[0]
  const target = await oidc.logoutTarget(request('https://moa.example.test/api/logout', cookie))
  assert.equal(new URL(target).pathname, '/logout')
  assert.equal(api.getAuth(request('https://moa.example.test/api/me', cookie)), null)
  assert.equal(await oidc.logoutTarget(request('https://moa.example.test/api/logout', nativeCookie)), '/login')
})
test('unlinking keeps native login but revokes all sessions for the identity', async () => {
  const body = { action: 'unlink', issuer, sub: 'subject-1', userId: member.id }
  assert.equal((await adminRoute.POST(request('https://moa.example.test/api/users/oidc', nativeCookie, 'POST', body))).status, 200)
  assert.equal(api.getAuth(request('https://moa.example.test/api/me', ssoCookie)), null)
  assert.ok(users.verifyUser(member.email, 'fixture-password'))
})
after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
