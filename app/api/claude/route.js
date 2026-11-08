// GET /api/claude — .claude skill/agent lists per registered project (owner only)
import { llmEnabled } from '../../../lib/llm.mjs'
import { buildIndex, readRegistry } from '../../../lib/content.mjs'
import { listClaude } from '../../../lib/claude.mjs'
import { j, guardOwner } from '../../../lib/api.mjs'

export async function GET(req) {
  const denied = guardOwner(req)
  if (denied) return denied
  if (llmEnabled()) return j(Object.fromEntries(buildIndex().projects.map(p => [p.slug, { skills: [], agents: [], provider: 'internal' }])))
  const out = {}
  for (const r of readRegistry().projects) out[r.slug] = listClaude(r.path)
  return j(out)
}
