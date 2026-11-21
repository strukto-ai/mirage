import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// A browser starts these workers from their bundles rather than from the
// entry files: a bundler that moves core's modules (Vite's dependency
// pre-bundling) leaves no entry file where a relative URL would find it.
// A worker never starts another from these bundles, so each leaves them out,
// and it runs on the mirage-rs module the page compiled, so each leaves out
// its bytes too.
const SOURCE_TYPES = 'declare const source: string\n\nexport default source\n'
const workers = {
  pyodide_worker: 'runtime/python/pyodide/worker/entry.ts',
  computation_worker: 'concurrency/worker_entry.ts',
  wasm_worker: 'runtime/wasm/worker.ts',
}
const output = new URL('../src/generated/', import.meta.url)
const built = new URL('../dist/generated/', import.meta.url)
mkdirSync(output, { recursive: true })
mkdirSync(built, { recursive: true })
for (const [name, entry] of Object.entries(workers)) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`../src/${entry}`, import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    logLevel: 'warning',
    external: ['node:*', 'pyodide'],
    // A blob has no URL to resolve a sibling against, and a module that
    // resolves one as it loads throws there.
    // Nothing in a worker fetches a sibling in a browser, so the bundle
    // gets a base that only has to parse.
    define: { 'import.meta.url': JSON.stringify('https://mirage.invalid/') },
    plugins: [
      {
        name: 'without-embedded-workers',
        setup(context) {
          context.onResolve({ filter: /generated\/\w+_worker|^#\w+-worker$/ }, (args) => ({
            path: args.path,
            external: true,
          }))
        },
      },
      {
        name: 'without-mirage-rs',
        setup(context) {
          context.onResolve(
            { filter: /^#mirage-(rs|shell)-wasm$|generated\/mirage_(rs|shell)/ },
            () => ({
              path: 'mirage_rs',
              namespace: 'without-mirage-rs',
            }),
          )
          context.onLoad({ filter: /.*/, namespace: 'without-mirage-rs' }, () => ({
            contents:
              "export const AHEAD = false\nexport default () => { throw new Error('a worker runs on the module its page hands it') }",
            loader: 'js',
          }))
        },
      },
    ],
  })
  // Imported as `#<name>` (package.json `imports`), written beside the
  // Rust modules so code run from source finds it too.
  writeFileSync(new URL(`${name}.d.ts`, output), SOURCE_TYPES)
  writeFileSync(
    new URL(`${name}.js`, built),
    `export default ${JSON.stringify(result.outputFiles[0].text)}\n`,
  )
}

// What a runtime with no Worker (workerd) imports in a worker's place: each
// import sits behind a check for Worker, so nothing there reads it, and the
// Worker's bundle carries no worker it cannot start.
writeFileSync(new URL('no_worker.js', built), "export default ''\n")
