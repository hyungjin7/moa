import { guardOwner, j } from '../../../../lib/api.mjs'
import { llmEnabled } from '../../../../lib/llm.mjs'
export async function GET(req) { return guardOwner(req) || j({ provider: llmEnabled() ? 'internal' : 'claude', tools: !llmEnabled() }) }
