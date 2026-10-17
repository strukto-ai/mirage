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
      'build',
      '-p',
      'mirage-rs-wasm',
      '--release',
      '--target',
      target,
      '--message-format=json-render-diagnostics',
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
      : 'embed-rs: cargo build -p mirage-rs-wasm failed (see above).',
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
const output = new URL('../src/generated/', import.meta.url)
mkdirSync(output, { recursive: true })
writeFileSync(
  new URL('mirage_rs.ts', output),
  `export default ${JSON.stringify(wasm.toString('base64'))}\n`,
)
