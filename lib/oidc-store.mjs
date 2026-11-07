// Single-process/PVC store. No provider tokens are sent to the browser.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ROOT } from './paths.mjs'
import { SECRET } from './auth.mjs'

const file = path.join(ROOT, 'oidc.json')
export const random = () => crypto.randomBytes(32).toString('base64url')
export const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const empty = () => ({ transactions: [], pending: [], bindings: [], sessions: [] })
export function readStore() {
  try { return { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) } }
  catch (e) { if (e.code === 'ENOENT') return empty(); throw e }
}
export function changeStore(fn) {
  // All read-modify-writes are synchronous; deploy one Node process/replica.
  const data = readStore(), now = Date.now()
  for (const key of ['transactions', 'pending', 'sessions']) data[key] = data[key].filter(r => r.exp > now)
  const result = fn(data)
  fs.mkdirSync(ROOT, { recursive: true })
  const temp = file + '.' + random() + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 })
  fs.renameSync(temp, file)
  return result
}
export function seal(value) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(SECRET).digest(), iv)
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}
export function unseal(value) {
  const b = Buffer.from(value, 'base64url')
  const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(SECRET).digest(), b.subarray(0, 12))
  decipher.setAuthTag(b.subarray(12, 28))
  return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString('utf8')
}
export function oidcSessionValid(claims, user) {
  if (claims.auth !== 'oidc') return true
  const data = readStore()
  const session = data.sessions.find(s => s.id === claims.sid && s.userId === user.id && s.exp > Date.now())
  return !!session && data.bindings.some(b => b.issuer === session.issuer && b.sub === session.sub && b.userId === user.id)
}
