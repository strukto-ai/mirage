import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// jq-wasm's browser build fetches jq.wasm from beside its own module, which
// is not there once a bundler moves that module (Vite's dependency
// pre-bundling) and cannot be resolved at all in a worker started from a
// blob, so core hands jq-wasm the bytes itself.
const require = createRequire(import.meta.url)
const wasm = readFileSync(require.resolve('jq-wasm/jq.wasm'))
const output = new URL('../src/generated/', import.meta.url)
mkdirSync(output, { recursive: true })
writeFileSync(
  new URL('jq.ts', output),
  `export default ${JSON.stringify(wasm.toString('base64'))} as string\n`,
)
