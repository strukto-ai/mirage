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
// A dependency's panic messages carry its source path. Dropping the registry
// prefix keeps a module the same bytes wherever cargo lives, and smaller.
const registry = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry', 'src')
const output = new URL('../src/generated/', import.meta.url)
const built = new URL('../dist/generated/', import.meta.url)

// Build one crate's module and write the files its `#mirage-*-wasm` import
// names. The streams module's dependencies and its LTO run at opt-level 2,
// which keeps it smaller, mirage-rs at the profile's 3 (awk is a tenth slower
// at 2), as does the shell module; gh's, which waits on GitHub, is built for
// size. `small` names the crates built for size inside a module, the codecs and
// parsers no hot loop waits on.
function embed(crate, name, build, small = []) {
  let messages
  try {
    messages = execFileSync(
      'cargo',
      [
        'rustc',
        '-p',
        crate,
        '--target',
        target,
        '--message-format=json-render-diagnostics',
        '--config',
        `target.${target}.rustflags=[${JSON.stringify(`--remap-path-prefix=${registry}=`)}]`,
        ...small.flatMap((name) => ['--config', `profile.release.package."${name}".opt-level="s"`]),
        ...build,
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
  mkdirSync(output, { recursive: true })
  writeFileSync(
    new URL(`${name}.d.ts`, output),
    'declare const module: WebAssembly.Module | (() => WebAssembly.Module)\n\nexport default module\n',
  )

  // Written here rather than by the build so code run from source (tsx, the
  // integ runners) finds them too: under workerd the .wasm its bundler loads,
  // under Node the .wasm read and compiled on first use from beside it, and
  // in a browser the .wasm fetched and compiled as the page loads.
  mkdirSync(built, { recursive: true })
  writeFileSync(new URL(`${name}.js`, built), fetched(name))
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

// A browser's main thread refuses to compile a module over 8 MB synchronously,
// so the page compiles it as it loads, and the top-level await hands every
// importer a compiled module. The `new URL` names the .wasm by the package's
// own export, which a bundler (Vite, webpack) resolves and ships: Vite's dev
// server resolves it from the dependency it pre-bundled, where a relative URL
// names a file it never copied there.
function fetched(name) {
  return `const url = new URL('@struktoai/mirage-core/${name}.wasm', import.meta.url)
const response = await fetch(url)
const type = response.headers.get('Content-Type') ?? ''
let module
if (response.ok && type.split(';')[0].trim() === 'application/wasm') {
  module = await WebAssembly.compileStreaming(response)
} else {
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!response.ok || String.fromCharCode(...bytes.subarray(0, 4)) !== '\\0asm') {
    throw new Error(
      \`\${url} answered \${response.status} \${type}, not WebAssembly: the page's bundler has to resolve and ship @struktoai/mirage-core/${name}.wasm, as Vite and webpack do. Vite's dev server resolves it from the app, so under pnpm add @struktoai/mirage-core to the app's dependencies.\`,
    )
  }
  module = await WebAssembly.compile(bytes)
}

export default module
`
}

embed(
  'mirage-rs-wasm',
  'mirage_rs',
  ['--release', '--config', 'profile.release.package."*".opt-level=2', '--', '-C', 'opt-level=2'],
  [
    'lzma-rust2',
    'libbz2-rs-sys',
    'bzip2',
    'regex-syntax',
    'fancy-regex',
    'num-bigint',
    'num-integer',
    'num-traits',
    'encoding_rs',
  ],
)
embed('mirage-shell-wasm', 'mirage_shell', ['--release', '--', '-C', 'opt-level=3'])
embed('mirage-gh-wasm', 'mirage_gh', ['--profile', 'wasm-size'])
