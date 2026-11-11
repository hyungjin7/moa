import { documentEditorAPI } from '../../../../lib/document-editor-api.mjs'
export const runtime = 'nodejs'
export async function GET(req) { return documentEditorAPI(req, 'read') }
export async function POST(req) { return documentEditorAPI(req, 'save') }
