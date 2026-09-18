// The pages never talk to Tauri: every platform call goes through lib/api, which the server
// answers on both products. Fails when any page-side source imports a Tauri package or reads
// its globals.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src', 'lib', 'store']
const PATTERNS = [/@tauri-apps\//, /__TAURI/]

function walk(dir, out) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) walk(path, out)
        else if (/\.(ts|tsx|js|jsx)$/.test(entry)) out.push(path)
    }
    return out
}

const offenders = []
for (const root of ROOTS) {
    for (const file of walk(root, [])) {
        const text = readFileSync(file, 'utf8')
        for (const pattern of PATTERNS) {
            if (pattern.test(text)) offenders.push(`${file}: ${pattern}`)
        }
    }
}
if (offenders.length) {
    console.error('Tauri references in page code:\n' + offenders.join('\n'))
    process.exit(1)
}
console.log('[checkNoTauri] ok')
