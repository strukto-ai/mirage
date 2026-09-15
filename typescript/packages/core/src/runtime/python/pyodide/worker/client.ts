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

import { PyodideUnavailableError } from '../errors.ts'
import { EvalError } from '../../../errors.ts'
import { CommandTimeoutError } from '../../../../commands/errors.ts'
import type { BridgeDispatchFn, EvalResult, RunResult, RuntimeContext } from '../../../types.ts'
import { RuntimeVFS } from '../../../vfs.ts'
import { applyMutation } from '../vfs/journal.ts'
import type { FlushFailure } from '../vfs/types.ts'
import { respond } from './transport.ts'
import type {
  ExecuteRequest,
  VfsRequest,
  WorkerMessage,
  WorkerPort,
  WorkerResult,
} from './types.ts'

async function createPort(): Promise<WorkerPort | null> {
  if (typeof SharedArrayBuffer === 'undefined') return null
  const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions
    ?.node
  if (node !== undefined) {
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
    }
  }
  if (typeof Worker === 'undefined') return null
  const worker = new Worker(new URL('./entry.js', import.meta.url), { type: 'module' })
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
        fn(new Error(event.message))
      }
    },
    terminate: () => {
      worker.terminate()
    },
  }
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
  private readonly interruptBuffer = new SharedArrayBuffer(16)
  private failure: Error | null = null

  private constructor(private readonly port: WorkerPort) {
    port.onMessage((message) => {
      if (message.kind === 'ready') {
        this.startup?.resolve()
        this.startup = null
        return
      }
      if (message.kind === 'vfs') this.buffers.add(message.buffer)
      if (this.waiter === null) this.messages.push(message)
      else {
        const waiter = this.waiter
        this.waiter = null
        waiter.resolve(message)
      }
    })
    port.onError((error) => {
      this.fail(error)
    })
  }

  static async create(): Promise<PyodideWorkerClient | null> {
    let client: PyodideWorkerClient | null = null
    try {
      const port = await createPort()
      if (port === null) return null
      client = new PyodideWorkerClient(port)
      // A constructed worker may still fail to load (for example under
      // CSP). Commit to it only after its message handler is listening.
      await client.ready
      return client
    } catch {
      client?.close()
      return null
    }
  }

  async execute(
    request: ExecuteRequest,
    context: RuntimeContext,
    signal?: AbortSignal,
  ): Promise<RunResult | EvalResult> {
    if (this.failure !== null) throw this.failure
    const vfs = new RuntimeVFS(context.dispatch, context.resolver)
    const { dispatch, scope } = context
    const responses = new Set<Promise<void>>()
    const cells = new Int32Array(this.interruptBuffer)
    Atomics.store(cells, 3, 0)
    const abort = (): void => {
      Atomics.store(cells, 3, 1)
      Atomics.store(cells, 1, 2)
      Atomics.store(cells, 0, 2)
    }
    if (signal?.aborted) abort()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      this.port.post({ ...request, interruptBuffer: this.interruptBuffer })
      for (;;) {
        const message = await this.nextMessage()
        if (message.kind === 'notice') {
          console.warn(message.message)
          continue
        }
        if (message.kind === 'vfs') {
          const response = respond(message.buffer, () =>
            scope.run(() => this.operation(message, vfs, dispatch)),
          )
          responses.add(response)
          void response.then(() => {
            responses.delete(response)
            this.buffers.delete(message.buffer)
          })
          continue
        }
        if (message.kind === 'result') return message.value
        if (message.name === 'PyodideUnavailableError')
          throw new PyodideUnavailableError(message.message)
        if (message.name === 'EvalError')
          throw new EvalError(message.message, { syntax: message.syntax ?? false })
        if (message.name === 'CommandTimeoutError' && message.seconds !== undefined)
          throw new CommandTimeoutError('pyodide', message.seconds)
        throw new Error(message.message)
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      // An interrupted guest can finish while a backend mutation is still pending.
      // Keep the runtime queue closed until every response has finished.
      await Promise.all(responses)
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

  private fail(error: Error): void {
    this.failure = error
    this.startup?.reject(error)
    this.startup = null
    this.waiter?.reject(error)
    this.waiter = null
    for (const buffer of this.buffers) {
      const cells = new Int32Array(buffer, 0, 4)
      Atomics.store(cells, 0, -1)
      Atomics.notify(cells, 0)
    }
    this.buffers.clear()
  }

  private async operation(
    request: VfsRequest,
    vfs: RuntimeVFS,
    dispatch: BridgeDispatchFn,
  ): Promise<unknown> {
    switch (request.op) {
      case 'read':
        return vfs.read(request.path)
      case 'stat':
        return vfs.stat(request.path, true)
      case 'readdir':
        return vfs.readdir(request.path)
      case 'readlink':
        return vfs.readlink(request.path)
      case 'dispatch': {
        if (request.args === undefined) throw new Error('missing bridge arguments')
        return dispatch(...request.args)
      }
      case 'flush': {
        const mutations = request.mutations ?? []
        for (const [index, mutation] of mutations.entries()) {
          try {
            await applyMutation(vfs, mutation)
          } catch (error) {
            return {
              message: `python3: failed to ${mutation.kind} ${mutation.path} on mount: ${error instanceof Error ? error.message : String(error)}`,
              skipped: mutations.length - index - 1,
            } satisfies FlushFailure
          }
        }
        return undefined
      }
    }
  }
}
