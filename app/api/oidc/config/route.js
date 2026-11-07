import { enabled } from '../../../../lib/oidc.mjs'
export const dynamic = 'force-dynamic'
export async function GET() { return Response.json({ enabled: enabled() }, { headers: { 'Cache-Control': 'no-store' } }) }
