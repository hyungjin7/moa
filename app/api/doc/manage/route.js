import { documentEditorAPI } from '../../../../lib/document-editor-api.mjs'
export const runtime = 'nodejs'
export async function GET(req) { return documentEditorAPI(req, 'manage') }
export async function POST(req) { return documentEditorAPI(req, 'manage') }
