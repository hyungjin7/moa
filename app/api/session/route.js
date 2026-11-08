import { llmEnabled, llmProject, llmSession, llmItems } from '../../../lib/llm.mjs'
// GET /api/session?slug=…&id=… — convert one session into chat items (owner only)
import path from 'node:path'
import { readRegistry } from '../../../lib/content.mjs'
import { findClaudeRoot, sessionItems } from '../../../lib/claude.mjs'
import { j, guardOwner } from '../../../lib/api.mjs'

export async function GET(req) {
  const denied = guardOwner(req)
  if (denied) return denied
  const url = new URL(req.url)
  const proj = llmEnabled() ? llmProject(url.searchParams.get('slug')) : readRegistry().projects.find((r) => r.slug === url.searchParams.get('slug'))
  if (!proj) return j({ error: 'Not a registered project.' }, 404)
  const id = String(url.searchParams.get('id') || '')
  if (!/^[\w-]+$/.test(id)) return j({ error: 'Invalid session id.' }, 400)
  if (llmEnabled()) {
    const s = llmSession(proj.slug, id)
    return s ? j({ id, ...llmItems(s) }) : j({ error: 'Conversation not found.' }, 404)
  }
  const root = findClaudeRoot(proj.path) || path.resolve(proj.path)
  const out = sessionItems(root, id)
  if (!out) return j({ error: 'Session transcript not found: ' + id }, 404)
  return j({ id, ...out })
}
