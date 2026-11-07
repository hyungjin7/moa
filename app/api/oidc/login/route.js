import { begin, failure } from '../../../../lib/oidc.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(req) { try { return await begin(req) } catch { return failure() } }
