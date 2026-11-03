import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'

const generated = new URL('../src/generated/', import.meta.url)
const output = new URL('../dist/generated/', import.meta.url)
mkdirSync(output, { recursive: true })
copyFileSync(new URL('mirage_rs.wasm', generated), new URL('mirage_rs.wasm', output))
writeFileSync(
  new URL('mirage_rs.workerd.js', output),
  "import module from './mirage_rs.wasm'\n\nexport default module\n",
)
