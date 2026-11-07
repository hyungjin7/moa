import fs from 'node:fs'
import path from 'node:path'
const root = process.env.MOA_CONTENT_ROOT || '/data'
for (const dir of ['projects', 'public']) fs.mkdirSync(path.join(root, dir), { recursive: true })
const guide = path.join(root, 'projects', 'guide')
if (!fs.existsSync(guide)) fs.cpSync('/app/projects/guide', guide, { recursive: true })
console.log('Persistent content directories ready (existing documents preserved).')
