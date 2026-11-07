import * as oidc from 'openid-client'
import { SECRET, parseCookies, readUserCookie, userSetCookie } from './auth.mjs'
import { findUserById } from './users.mjs'
import { changeStore, random, digest, seal, unseal } from './oidc-store.mjs'

export const TX_COOKIE = 'moa_oidc_tx'
export const enabled = () => process.env.MOA_OIDC_ENABLED === '1'
export function settings() {
  if (!enabled() || !SECRET) throw new Error('SSO is not configured')
  const issuer = new URL(process.env.MOA_OIDC_ISSUER)
  const origin = new URL(process.env.MOA_PUBLIC_ORIGIN)
  if (issuer.protocol !== 'https:' || origin.protocol !== 'https:') throw new Error('SSO requires HTTPS')
  const clientId = process.env.MOA_OIDC_CLIENT_ID
  const secret = process.env.MOA_OIDC_CLIENT_SECRET
  if (!clientId || !secret || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('Invalid SSO configuration')
  return { issuer: issuer.href.replace(/\/$/, ''), origin: origin.origin, clientId, secret, callback: origin.origin + '/api/oidc/callback' }
}
let cached
export async function provider() {
  if (!cached) cached = (async () => {
    const cfg = settings()
    const client = await oidc.discovery(new URL(cfg.issuer), cfg.clientId, cfg.secret)
    oidc.enableNonRepudiationChecks(client) // Require JWKS signature verification, as well as TLS/issuer/audience checks.
    if (client.serverMetadata().issuer !== cfg.issuer) throw new Error('Issuer mismatch')
    return client
  })().catch(e => { cached = null; throw e })
  return cached
}
export function safeNext(value) {
  const origin = settings().origin
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/'
  const target = new URL(value, origin)
  return target.origin === origin && !target.pathname.startsWith('/api/') && target.pathname !== '/login' ? target.pathname + target.search + target.hash : '/'
}
export function sameOrigin(req) {
  return req.headers.get('origin') === settings().origin
}
const txCookie = value => `${TX_COOKIE}=${value}; Path=/api/oidc; HttpOnly; Secure; SameSite=Lax; Max-Age=${value ? 600 : 0}`
export const clearTransaction = () => txCookie('')
const redirect = (url, cookies = []) => {
  const headers = new Headers({ Location: String(url), 'Cache-Control': 'no-store' })
  for (const cookie of cookies) headers.append('Set-Cookie', cookie)
  return new Response(null, { status: 303, headers })
}
export const clearLoginCookies = () => ['moa_owner', 'moa_user'].map(name => `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`)
export async function begin(req) {
  const cfg = settings(), client = await provider()
  const verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce(), browser = random()
  const next = safeNext(new URL(req.url).searchParams.get('next'))
  changeStore(d => {
    d.transactions = d.transactions.filter(t => t.browser !== digest(parseCookies(req)[TX_COOKIE] || ''))
    d.transactions.push({ state, nonce, verifier, browser: digest(browser), next, exp: Date.now() + 600000 })
    d.transactions = d.transactions.slice(-200)
  })
  const url = oidc.buildAuthorizationUrl(client, { redirect_uri: cfg.callback, response_type: 'code', scope: 'openid email profile', state, nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' })
  return redirect(url, [txCookie(browser)])
}
export async function finish(req) {
  const cfg = settings()
  const incoming = new URL(req.url), state = incoming.searchParams.get('state')
  const browser = parseCookies(req)[TX_COOKIE]
  if (!state || !browser) throw new Error('Missing transaction')
  const tx = changeStore(d => {
    const i = d.transactions.findIndex(t => t.state === state && t.browser === digest(browser))
    return i < 0 ? null : d.transactions.splice(i, 1)[0]
  })
  if (!tx) throw new Error('Expired or consumed transaction')
  const client = await provider()
  const tokens = await oidc.authorizationCodeGrant(client, new URL(cfg.callback + incoming.search), {
    expectedState: tx.state, expectedNonce: tx.nonce, pkceCodeVerifier: tx.verifier, idTokenExpected: true,
  })
  const claims = tokens.claims()
  if (!claims?.sub || claims.iss !== cfg.issuer) throw new Error('Invalid identity')
  const result = changeStore(d => {
    const binding = d.bindings.find(b => b.issuer === cfg.issuer && b.sub === claims.sub)
    const user = binding && findUserById(binding.userId)
    if (!user) {
      if (!d.pending.some(p => p.issuer === cfg.issuer && p.sub === claims.sub)) {
        d.pending.push({ id: random(), issuer: cfg.issuer, sub: claims.sub, email: String(claims.email || '').slice(0, 254),
          name: String(claims.name || claims.preferred_username || '').slice(0, 200), exp: Date.now() + 86400000 })
        d.pending = d.pending.slice(-200)
      }
      return { pending: true }
    }
    if (user.disabled) throw new Error('Disabled local account')
    const sid = random(), exp = Date.now() + 8 * 3600000
    d.sessions.push({ id: sid, userId: user.id, issuer: cfg.issuer, sub: claims.sub, exp, idToken: seal(tokens.id_token) })
    return { user, sid, exp }
  })
  const cookies = [clearTransaction(), ...clearLoginCookies()]
  if (result.pending) {
    return redirect(cfg.origin + '/login?msg=' + encodeURIComponent('Keycloak 인증 완료: MOA 관리자에게 계정 연결 승인을 요청하세요.'), cookies)
  }
  cookies.push(userSetCookie(result.user, { auth: 'oidc', sid: result.sid, exp: result.exp }))
  return redirect(cfg.origin + tx.next, cookies)
}
export function failure() {
  const url = new URL('/login', process.env.MOA_PUBLIC_ORIGIN || 'http://localhost:5001')
  url.searchParams.set('msg', 'Keycloak 로그인에 실패했습니다. 다시 시도하거나 자체 계정으로 로그인하세요.')
  return redirect(url, [clearTransaction()])
}
export async function logoutTarget(req) {
  const c = readUserCookie(req)
  if (c?.auth !== 'oidc') return '/login'
  const session = changeStore(d => {
    const i = d.sessions.findIndex(s => s.id === c.sid && s.userId === c.u)
    return i < 0 ? null : d.sessions.splice(i, 1)[0]
  })
  if (!session) return '/login'
  try {
    return oidc.buildEndSessionUrl(await provider(), { id_token_hint: unseal(session.idToken),
      post_logout_redirect_uri: settings().origin + '/login', client_id: settings().clientId }).href
  } catch { return '/login' } // Local session has already been revoked even during an IdP outage.
}
