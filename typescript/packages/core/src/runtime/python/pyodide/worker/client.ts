// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { noWorker, PyodideMemoryError, PyodideUnavailableError } from '../errors.ts'
import { watchMemory } from '../watchdog.ts'
import { memoryLimit } from '../../../config.ts'
import { classify } from '../../../../errors/classify.ts'
import { CommandTimeoutError } from '../../../../errors/types.ts'
import type { Context } from '../../../../commands/config.ts'
import { currentCaller, runWithCaller } from '../../../../context/session_context.ts'
import type { RunResult } from '../../../types.ts'
import type { RuntimeFiles } from '../../../files.ts'
import { READ } from '../../../handles/mode.ts'
import { applyMutation } from '../fs/journal.ts'
import type { FlushFailure } from '../fs/types.ts'
import { failureText } from './failure.ts'
import { compiledModule } from '../../../../rs/stream.ts'
import { answerOverBridge, bridged, respond } from './transport.ts'
import { GuestProcessTable } from './process.ts'
import type {
  ExecuteRequest,
  VfsRequest,
  WorkerMessage,
  WorkerPort,
  WorkerResult,
} from './types.ts'

/**
 * The page URL its service worker bridges file calls at, or null when no
 * service worker controlling the page answers the bridge.
 */
async function serviceWorkerBridge(): Promise<string | null> {
  const host = globalThis as {
    navigator?: { serviceWorker?: { controller: unknown } }
    location?: { origin: string; pathname: string }
  }
  if (host.navigator?.serviceWorker?.controller == null || host.location === undefined) return null
  const bridge = host.location.origin + host.location.pathname
  return (await bridged(bridge)) ? bridge : null
}

async function createPort(): Promise<WorkerPort | null> {
  const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions
    ?.node
  if (node !== undefined) {
    if (typeof SharedArrayBuffer === 'undefined') return null
    const { Worker } = await import('node:worker_threads')
    const url = new URL(
      import.meta.url.endsWith('.ts') ? './entry.ts' : './entry.js',
      import.meta.url,
    )
    const worker = new Worker(url, {
      execArgv: url.pathname.endsWith('.ts')
        ? ['--experimental-transform-types', '--disable-warning=ExperimentalWarning']
        : [],
    })
    // Node 22.16 and later read a worker's heap, wasm memory included,
    // even while its guest is busy; older ones run without the watch.
    const stats = worker as unknown as {
      getHeapStatistics?: () => Promise<{ external_memory: number }>
    }
    const heap = stats.getHeapStatistics?.bind(worker)
    return {
      post: (m) => {
        worker.postMessage(m)
      },
      onMessage: (fn) => {
        worker.on('message', fn)
      },
      onError: (fn) => {
        worker.on('error', fn)
        worker.on('exit', (code: number) => {
          fn(new Error(`pyodide worker exited (${String(code)})`))
        })
      },
      terminate: () => {
        void worker.terminate()
      },
      ...(heap !== undefined ? { memory: async () => (await heap()).external_memory } : {}),
    }
  }
  if (typeof Worker === 'undefined') return null
  const bridge = typeof SharedArrayBuffer === 'undefined' ? await serviceWorkerBridge() : undefined
  if (bridge === null) return null
  // The worker starts from the bundle core embeds, not from a file beside
  // this module: a bundler that moves this module (Vite's dependency
  // pre-bundling) leaves no file where a relative URL would look.
  const { default: source } = await import('../../../../generated/pyodide_worker.ts')
  const wasm = await compiledModule()
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  const worker = new Worker(url, { type: 'module' })
  return {
    post: (m) => {
      worker.postMessage(m)
    },
    onMessage: (fn) => {
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        fn(event.data)
      }
    },
    onError: (fn) => {
      worker.onerror = (event) => {
        // A script the page refuses to start carries no message.
        fn(new Error(event.message || 'its script did not start'))
      }
    },
    terminate: () => {
      worker.terminate()
      URL.revokeObjectURL(url)
    },
    wasm,
    ...(bridge !== undefined ? { bridge } : {}),
  }
}

/**
 * What a crashed worker reported, as an Error a command can print. A
 * worker's uncaught exception arrives structured-cloned: an Error stays
 * one, but anything else arrives as a plain value whose String() may be
 * `[object Object]`.
 */
export function workerFailure(value: unknown): Error {
  return value instanceof Error ? value : new Error(`pyodide worker crashed: ${failureText(value)}`)
}

export class PyodideWorkerClient {
  private startup: { resolve: () => void; reject: (error: Error) => void } | null = null
  private readonly ready = new Promise<void>((resolve, reject) => {
    this.startup = { resolve, reject }
  })
  private readonly messages: (VfsRequest | WorkerResult)[] = []
  private waiter: {
    resolve: (message: VfsRequest | WorkerResult) => void
    reject: (error: Error) => void
  } | null = null
  private readonly buffers = new Set<SharedArrayBuffer>()
  // Null where no memory is shared: nothing then reaches a busy guest, and
  // an interrupted run ends with its worker.
  private readonly interruptBuffer =
    typeof SharedArrayBuffer === 'undefined' ? null : new SharedArrayBuffer(16)
  private failure: Error | null = null

  private constructor(private readonly port: WorkerPort) {
    port.onMessage((message) => {
      if (message.kind === 'ready') {
        this.startup?.resolve()
        this.startup = null
        return
      }
      if (message.kind === 'vfs' && message.buffer !== undefined) this.buffers.add(message.buffer)
      if (this.waiter === null) this.messages.push(message)
      else {
        const waiter = this.waiter
        this.waiter = null
        waiter.resolve(message)
      }
    })
    port.onError((error) => {
      this.fail(workerFailure(error))
    })
  }

  /** A started worker, or the refusal that says why none could start. */
  static async create(): Promise<PyodideWorkerClient | PyodideUnavailableError> {
    let client: PyodideWorkerClient | null = null
    try {
      const port = await createPort()
      if (port === null) return noWorker()
      client = new PyodideWorkerClient(port)
      // A constructed worker may still fail to load (for example under
      // CSP). Commit to it only after its message handler is listening.
      await client.ready
      return client
    } catch (error) {
      client?.close()
      return noWorker(error)
    }
  }

  /**
   * Run one request on the worker, answering its file and process calls
   * until it reports.
   *
   * @param request the program and what of the run's context it reads.
   * @param ctx the run's context: its processes, and the signal that
   *   interrupts the guest.
   * @param files the run's file adapter, which answers the guest's calls.
   */
  async execute(request: ExecuteRequest, ctx: Context, files: RuntimeFiles): Promise<RunResult> {
    if (this.failure !== null) throw this.failure
    const signal = ctx.signal
    // The guest's calls stop once the run is cancelled; the run's end
    // still closes what it left open through `files`.
    const live = signal === undefined ? files : files.withSignal(signal)
    // The run's caller, which each call the guest makes runs as.
    const caller = currentCaller()
    const responses = new Set<Promise<void>>()
    // A child's program is found through the guest's view, so none starts
    // once the run is cancelled.
    const processes = new GuestProcessTable(ctx, live)
    // The core handles the guest's streams hold open.
    const handles = new Set<number>()
    const cap = request.config.maxMemory ?? null
    const limit = memoryLimit(cap)
    const unwatch =
      limit !== null && cap !== null && this.port.memory !== undefined
        ? watchMemory(this.port.memory, limit, () => {
            this.port.terminate()
            this.fail(new PyodideMemoryError(String(cap)))
          })
        : null
    const cells = this.interruptBuffer === null ? null : new Int32Array(this.interruptBuffer)
    if (cells !== null) Atomics.store(cells, 3, 0)
    const abort = (): void => {
      if (cells === null) {
        this.fail(new Error('pyodide worker interrupted'))
        this.port.terminate()
        return
      }
      Atomics.store(cells, 3, 1)
      Atomics.store(cells, 1, 2)
      Atomics.store(cells, 0, 2)
    }
    if (signal?.aborted) abort()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      this.port.post({
        ...request,
        ...(this.interruptBuffer !== null ? { interruptBuffer: this.interruptBuffer } : {}),
        ...(this.port.bridge !== undefined ? { bridge: this.port.bridge } : {}),
        ...(this.port.wasm !== undefined ? { wasm: this.port.wasm } : {}),
      })
      for (;;) {
        const message = await this.nextMessage()
        if (message.kind === 'notice') {
          console.warn(message.message)
          continue
        }
        if (message.kind === 'vfs') {
          const response = this.answer(message, () =>
            runWithCaller(caller, () => this.operation(message, live, processes, handles)),
          )
          responses.add(response)
          void response.then(() => {
            responses.delete(response)
            if (message.buffer !== undefined) this.buffers.delete(message.buffer)
          })
          continue
        }
        if (message.kind === 'result') return message.value
        if (message.name === 'PyodideUnavailableError')
          throw new PyodideUnavailableError(message.message)
        if (message.name === 'CommandTimeoutError' && message.seconds !== undefined)
          throw new CommandTimeoutError('pyodide', message.seconds)
        throw new Error(message.message)
      }
    } finally {
      unwatch?.()
      signal?.removeEventListener('abort', abort)
      // An interrupted guest can finish while a backend mutation is still pending.
      // Keep the runtime queue closed until every response has finished.
      await processes.close()
      await Promise.all(responses)
      // The run's end closes what the guest left open; one still open here
      // ended with its guest mid-call, so a landing that fails has no one
      // to tell.
      for (const fh of handles) {
        try {
          await files.close(fh)
        } catch (error) {
          console.debug(`pyodide: landing an open file failed: ${String(error)}`)
        }
      }
    }
  }

  private nextMessage(): Promise<VfsRequest | WorkerResult> {
    if (this.failure !== null) return Promise.reject(this.failure)
    const message = this.messages.shift()
    if (message !== undefined) return Promise.resolve(message)
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  close(): void {
    this.fail(new Error('pyodide worker closed'))
    this.port.terminate()
  }

  // The first failure is the one to report: a worker that throws is also
  // reported as exited right after, which says less about why.
  private fail(error: Error): void {
    this.failure ??= error
    const failure = this.failure
    this.startup?.reject(failure)
    this.startup = null
    this.waiter?.reject(failure)
    this.waiter = null
    for (const buffer of this.buffers) {
      const cells = new Int32Array(buffer, 0, 4)
      Atomics.store(cells, 0, -1)
      Atomics.notify(cells, 0)
    }
    this.buffers.clear()
  }

  /**
   * Answer one call from the worker, through the memory it shares or
   * through the page's service worker.
   *
   * @param message the worker's call.
   * @param operation computes the answer.
   */
  private async answer(message: VfsRequest, operation: () => Promise<unknown>): Promise<void> {
    if (message.buffer !== undefined) {
      await respond(message.buffer, operation)
      return
    }
    try {
      if (this.port.bridge === undefined || message.id === undefined)
        throw new Error('pyodide worker call names no way to answer it')
      await answerOverBridge(this.port.bridge, message.id, operation)
    } catch (error) {
      // An answer that cannot reach the worker leaves it waiting forever.
      this.fail(workerFailure(error))
      this.port.terminate()
    }
  }

  private async operation(
    request: VfsRequest,
    files: RuntimeFiles,
    processes: GuestProcessTable,
    handles: Set<number>,
  ): Promise<unknown> {
    const fh = request.fh ?? -1
    switch (request.op) {
      case 'process':
        // A child reads the mounts, so what an open file wrote lands
        // first, as a child would read it from the page cache.
        for (const open of handles) await files.fsync(open)
        return processes.call(request.payload ?? '{}')
      case 'open': {
        const opened = await files.open(request.path, request.mode ?? READ)
        handles.add(opened)
        return opened
      }
      case 'pread':
        return files.pread(fh, request.offset ?? 0, request.size ?? 0)
      case 'pwrite':
        return files.pwrite(fh, request.offset ?? 0, request.bytes ?? new Uint8Array())
      case 'fstat':
        return files.fstat(fh)
      case 'ftruncate':
        return files.ftruncate(fh, request.size ?? 0)
      case 'close':
        handles.delete(fh)
        return files.close(fh)
      case 'stat':
        return files.stat(request.path, true)
      case 'readdir':
        return files.readdir(request.path, request.classify ?? true)
      case 'readlink':
        return files.readlink(request.path)
      case 'dispatch': {
        if (request.args === undefined) throw new Error('missing bridge arguments')
        return files.bridge(...request.args)
      }
      case 'flush': {
        const mutations = request.mutations ?? []
        for (const [index, mutation] of mutations.entries()) {
          try {
            await applyMutation(files, mutation)
          } catch (error) {
            const code = classify(error)
            return {
              message: `python3: failed to ${mutation.kind} ${mutation.path} on mount: ${error instanceof Error ? error.message : String(error)}`,
              skipped: mutations.length - index - 1,
              ...(code === null ? {} : { code }),
            } satisfies FlushFailure
          }
        }
        return undefined
      }
    }
  }
}
