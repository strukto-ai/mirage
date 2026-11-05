import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = fileURLToPath(new URL('../../../../rust/', import.meta.url))
const target = 'wasm32-unknown-unknown'
const env = {
  ...process.env,
  PATH: [process.env.PATH, join(homedir(), '.cargo', 'bin')].filter(Boolean).join(delimiter),
}
let messages
try {
  messages = execFileSync(
    'cargo',
    [
      'rustc',
      '-p',
      'mirage-rs-wasm',
      '--release',
      '--target',
      target,
      '--message-format=json-render-diagnostics',
      '--',
      '-C',
      'opt-level=2',
    ],
    {
      cwd: workspace,
      env,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  )
} catch (error) {
  // Cargo has already printed its own errors; a missing cargo has none.
  console.error(
    error.code === 'ENOENT'
      ? 'embed-rs: cargo not found. Install rustup (https://rustup.rs); rust/rust-toolchain.toml then fetches the pinned toolchain.'
      : 'embed-rs: cargo rustc -p mirage-rs-wasm failed (see above).',
  )
  process.exit(1)
}
// Cargo names the file it wrote, wherever CARGO_TARGET_DIR or a config
// puts the target directory.
const path = messages
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((message) => message.reason === 'compiler-artifact')
  .flatMap((message) => message.filenames)
  .find((file) => file.endsWith('mirage_rs_wasm.wasm'))
if (path === undefined) throw new Error('cargo reported no mirage_rs_wasm.wasm')
const wasm = readFileSync(path)
const browserLimit = 8 * 1024 * 1024
if (wasm.byteLength > browserLimit) {
  throw new Error(
    `mirage-rs Wasm is ${wasm.byteLength} bytes, exceeding the browser synchronous compilation and instantiation limit of ${browserLimit} bytes`,
  )
}
const output = new URL('../src/generated/', import.meta.url)
mkdirSync(output, { recursive: true })
const base64 = JSON.stringify(wasm.toString('base64'))
writeFileSync(new URL('mirage_rs.ts', output), `export default ${base64} as string\n`)
writeFileSync(new URL('mirage_rs.wasm', output), wasm)

// The modules `#mirage-rs-wasm` names, written here rather than by the
// build so code run from source (tsx, the integ runners) finds them too:
// under workerd the .wasm its bundler loads, under Node the .wasm read and
// compiled from beside it, and elsewhere the base64 string.
const built = new URL('../dist/generated/', import.meta.url)
mkdirSync(built, { recursive: true })
writeFileSync(new URL('mirage_rs.js', built), `export default ${base64}\n`)
writeFileSync(new URL('mirage_rs.wasm', built), wasm)
writeFileSync(
  new URL('mirage_rs.workerd.js', built),
  "import module from './mirage_rs.wasm'\n\nexport default module\n",
)
writeFileSync(
  new URL('mirage_rs.node.js', built),
  "import { readFileSync } from 'node:fs'\n\n" +
    "export default new WebAssembly.Module(readFileSync(new URL('./mirage_rs.wasm', import.meta.url)))\n",
)
