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
const browserLimit = 8 * 1024 * 1024
const output = new URL('../src/generated/', import.meta.url)
const built = new URL('../dist/generated/', import.meta.url)

// Build one crate's module and write the files its `#mirage-*-wasm` import
// names. The streams module stays at opt-level 2 to fit the browser's limit;
// the shell module, a fraction of it, takes the profile's 3. `small` names the
// crates built for size instead, the codecs and parsers no hot loop waits on.
function embed(crate, name, optLevel, small = []) {
  let messages
  try {
    messages = execFileSync(
      'cargo',
      [
        'rustc',
        '-p',
        crate,
        '--release',
        '--target',
        target,
        '--message-format=json-render-diagnostics',
        ...small.flatMap((name) => ['--config', `profile.release.package."${name}".opt-level="s"`]),
        '--',
        '-C',
        `opt-level=${optLevel}`,
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
        : `embed-rs: cargo rustc -p ${crate} failed (see above).`,
    )
    process.exit(1)
  }
  // Cargo names the file it wrote, wherever CARGO_TARGET_DIR or a config
  // puts the target directory.
  const artifact = `${crate.replaceAll('-', '_')}.wasm`
  const path = messages
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((message) => message.reason === 'compiler-artifact')
    .flatMap((message) => message.filenames)
    .find((file) => file.endsWith(artifact))
  if (path === undefined) throw new Error(`cargo reported no ${artifact}`)
  const wasm = readFileSync(path)
  if (wasm.byteLength > browserLimit) {
    throw new Error(
      `${crate} Wasm is ${wasm.byteLength} bytes, exceeding the browser synchronous compilation and instantiation limit of ${browserLimit} bytes`,
    )
  }
  mkdirSync(output, { recursive: true })
  const base64 = JSON.stringify(wasm.toString('base64'))
  writeFileSync(new URL(`${name}.ts`, output), `export default ${base64} as string\n`)
  writeFileSync(new URL(`${name}.wasm`, output), wasm)

  // Written here rather than by the build so code run from source (tsx, the
  // integ runners) finds them too: under workerd the .wasm its bundler loads,
  // under Node the .wasm read and compiled on first use from beside it, and
  // elsewhere the base64 string.
  mkdirSync(built, { recursive: true })
  writeFileSync(new URL(`${name}.js`, built), `export default ${base64}\n`)
  writeFileSync(new URL(`${name}.wasm`, built), wasm)
  writeFileSync(
    new URL(`${name}.workerd.js`, built),
    `import module from './${name}.wasm'\n\nexport default module\n`,
  )
  writeFileSync(
    new URL(`${name}.node.js`, built),
    "import { readFileSync } from 'node:fs'\n\n" +
      'let module\n\nexport default function loadModule() {\n' +
      `  return module ??= new WebAssembly.Module(readFileSync(new URL('./${name}.wasm', import.meta.url)))\n` +
      '}\n',
  )
}

embed('mirage-rs-wasm', 'mirage_rs', 2, [
  'lzma-rust2',
  'libbz2-rs-sys',
  'bzip2',
  'regex-syntax',
  'fancy-regex',
  'num-bigint',
  'num-integer',
  'num-traits',
  'encoding_rs',
])
embed('mirage-shell-wasm', 'mirage_shell', 3)
