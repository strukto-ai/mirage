import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripCustomSections } from '../../core/scripts/strip-custom-sections.mjs'

const require = createRequire(import.meta.url)
const tool = require.resolve('binaryen/bin/wasm-opt')
const version = require('binaryen/package.json').version
const options = [
  '-Oz',
  '--enable-bulk-memory',
  '--enable-nontrapping-float-to-int',
  '--enable-sign-ext',
  '--enable-reference-types',
  '--enable-multivalue',
]
const cache = join(
  process.env.MIRAGE_WASM_OPT_CACHE ??
    fileURLToPath(new URL('../node_modules/.cache/', import.meta.url)),
  'cloudflare',
)

/** Shrink the two largest SDK modules before Wrangler counts their uncompressed bytes. */
export function optimizeWasm(path) {
  const input = stripCustomSections(readFileSync(path))
  const key = createHash('sha256')
    .update(JSON.stringify([version, options]))
    .update(input)
    .digest('hex')
  const cached = join(cache, key + '.wasm')
  if (!existsSync(cached)) {
    mkdirSync(cache, { recursive: true })
    const temporary = cached + '.' + randomUUID()
    try {
      execFileSync(process.execPath, [tool, ...options, '-', '-o', temporary], { input })
      renameSync(temporary, cached)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  return readFileSync(cached)
}
