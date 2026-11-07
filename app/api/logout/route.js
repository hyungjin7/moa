import { logoutTarget } from '../../../lib/oidc.mjs'
export async function POST(req) {
  const expected = process.env.MOA_PUBLIC_ORIGIN || new URL(req.url).origin
  if (req.headers.get('origin') && req.headers.get('origin') !== expected) return Response.json({ error: 'Invalid origin' }, { status: 403 })
  const redirect = await logoutTarget(req)
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  for (const name of ['moa_owner', 'moa_user']) headers.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${expected.startsWith('https://') ? '; Secure' : ''}`)
  return new Response(JSON.stringify({ ok: true, redirect }), { status: 200, headers })
}
