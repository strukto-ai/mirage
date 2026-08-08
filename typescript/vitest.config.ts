import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    pool: 'forks',
    // JSPI serves only the pyodide shim's lazy backfill (run_sync in
    // mirage_fs_shim.ts); production runs without it, so nothing else
    // may depend on this flag. runtime_nojspi.test.ts pins the
    // no-JSPI write path by deleting WebAssembly.Suspending.
    poolOptions: {
      forks: {
        execArgv: ['--experimental-wasm-jspi'],
      },
      threads: {
        execArgv: ['--experimental-wasm-jspi'],
      },
    },
  },
})
