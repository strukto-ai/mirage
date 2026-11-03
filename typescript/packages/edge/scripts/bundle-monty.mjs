import { build } from 'esbuild'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const monty = fileURLToPath(new URL('../node_modules/@pydantic/monty/', import.meta.url))
const output = new URL('../src/generated/', import.meta.url)
mkdirSync(output, { recursive: true })

await build({
  stdin: {
    contents: [
      "export { serveDispatch } from './dist/worker/serve.js'",
      "export { WorkerChannel } from './dist/worker/channel.js'",
      "export { createWorkerPoolFromFactory, workerChannelOptions } from './dist/worker/poolOptions.js'",
      "export * from './dist/shared.js'",
    ].join('\n'),
    resolveDir: monty,
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external: ['@opentelemetry/*', '@bytecodealliance/*', 'node:*'],
  outfile: fileURLToPath(new URL('monty.js', output)),
  logLevel: 'warning',
})
writeFileSync(
  new URL('monty.d.ts', output),
  [
    "export * from '@pydantic/monty/wasm'",
    'export declare function serveDispatch(',
    '  modules: Record<string, WebAssembly.Module>,',
    '  post: (reply: unknown) => void,',
    '  subscribe: (handler: (request: unknown) => void) => void,',
    '): Promise<void>',
    'export declare const WorkerChannel: {',
    '  create(like: unknown, options: unknown, signal?: AbortSignal): Promise<unknown>',
    '}',
    'export declare function createWorkerPoolFromFactory(',
    '  factory: (signal?: AbortSignal) => Promise<unknown>,',
    '  options: Record<string, unknown>,',
    '  concurrency: number,',
    '): Promise<{',
    '  checkout(options?: Record<string, unknown>): Promise<never>',
    '  close(): Promise<void>',
    '}>',
    'export declare function workerChannelOptions(options: Record<string, unknown>): unknown',
    '',
  ].join('\n'),
)
for (const part of ['core', 'core2', 'core3', 'core4']) {
  const name = `monty.component.${part}.wasm`
  copyFileSync(`${monty}dist/worker/component/${name}`, new URL(name, output))
}
