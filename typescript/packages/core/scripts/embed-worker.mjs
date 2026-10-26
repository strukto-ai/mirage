import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// A browser starts these workers from their bundles rather than from the
// entry files: a bundler that moves core's modules (Vite's dependency
// pre-bundling) leaves no entry file where a relative URL would find it.
// A worker never starts another from these bundles, so each leaves them out,
// and it runs on the mirage-rs module the page compiled, so each leaves out
// its bytes too.
const workers = {
  pyodide_worker: 'runtime/python/pyodide/worker/entry.ts',
  computation_worker: 'concurrency/worker_entry.ts',
  wasm_worker: 'runtime/wasm/worker.ts',
}
const output = new URL('../src/generated/', import.meta.url)
mkdirSync(output, { recursive: true })
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
    // resolves one as it loads (jq-wasm's browser build) throws there.
    // Nothing in a worker fetches a sibling in a browser, so the bundle
    // gets a base that only has to parse.
    define: { 'import.meta.url': JSON.stringify('https://mirage.invalid/') },
    plugins: [
      {
        name: 'without-embedded-workers',
        setup(context) {
          context.onResolve({ filter: /generated\/\w+_worker/ }, (args) => ({
            path: args.path,
            external: true,
          }))
        },
      },
      {
        name: 'without-mirage-rs',
        setup(context) {
          context.onResolve({ filter: /generated\/mirage_rs/ }, () => ({
            path: 'mirage_rs',
            namespace: 'without-mirage-rs',
          }))
          context.onLoad({ filter: /.*/, namespace: 'without-mirage-rs' }, () => ({
            contents: 'export default ""',
            loader: 'js',
          }))
        },
      },
    ],
  })
  writeFileSync(
    new URL(`${name}.ts`, output),
    `export default ${JSON.stringify(result.outputFiles[0].text)} as string\n`,
  )
}
