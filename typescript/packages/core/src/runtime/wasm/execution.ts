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

import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import type { ByteSource } from '../../io/types.ts'
import { abortable, makeAbortError, sleep } from '../../utils/abort.ts'
import { concat } from '../../utils/bytes.ts'
import type { Descriptor } from '../files.ts'
import type { OpenMode } from '../handles/mode.ts'
import type { OutputFn, VFSStat } from '../types.ts'
import {
  answerOverBridge,
  type BridgeCall,
  failureText,
  respond,
  serviceWorkerBridge,
} from './transport.ts'
import type { WasmView } from './view.ts'

/** One run the host hands a worker: the module and what the guest starts with. */
export interface GuestRun {
  module: WebAssembly.Module
  argv: string[]
  /** `NAME=value` entries. */
  env: string[]
  /** The run has input, which the guest reads as from a pipe. */
  piped: boolean
  /** The page URL the service worker bridges calls at, where no memory is shared. */
  bridge?: string
}

/** One blocking call the guest makes of the host. */
export interface GuestCall {
  op: 'view' | 'file' | 'stdin' | 'output' | 'sleep'
  method?: string
  /** The open file a `file` call is on: its core handle. */
  file?: number
  args?: unknown[]
}

export type GuestReply =
  | { kind: 'ready' }
  | { kind: 'result'; exitCode: number; trap: string | null; lost: string[] }
  | { kind: 'error'; message: string }

type Message = GuestReply | (GuestCall & BridgeCall)

/** A worker, its messages and failures going to the one run it serves. */
interface Port {
  post(message: unknown): void
  /** Hand its messages and its failure to `receive`, in place of the last run's. */
  listen(receive: (message: Message | Error) => void): void
  terminate(): void
  bridge?: string
}

/** A port over a worker, its listener swapped per run. */
function portOf(
  post: (message: unknown) => void,
  attach: (receive: (message: Message | Error) => void) => void,
  terminate: () => void,
  bridge?: string,
): Port {
  let receive: (message: Message | Error) => void = () => undefined
  attach((message) => {
    receive(message)
  })
  return {
    post,
    listen: (fn) => {
      receive = fn
    },
    terminate,
    ...(bridge !== undefined ? { bridge } : {}),
  }
}

const NO_WORKER =
  'a wasm guest runs on a worker, which this page cannot start: it needs shared memory ' +
  '(a cross-origin isolated page) or mirage’s service worker bridge'

/** Why no guest worker can start here, or null when one can. */
export async function workerUnavailable(): Promise<string | null> {
  const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions
    ?.node
  if (node !== undefined || typeof SharedArrayBuffer !== 'undefined') return null
  if (typeof Worker === 'undefined') return NO_WORKER
  return (await serviceWorkerBridge()) === null ? NO_WORKER : null
}

/** A worker for one guest at a time, or null where none can start: a page
 * that shares no memory and has no service worker to bridge its calls. */
async function startWorker(): Promise<Port | null> {
  const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions
    ?.node
  if (node !== undefined) {
    const { Worker } = await import('node:worker_threads')
    const url = new URL(
      import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js',
      import.meta.url,
    )
    const worker = new Worker(url, {
      execArgv: url.pathname.endsWith('.ts')
        ? ['--experimental-transform-types', '--disable-warning=ExperimentalWarning']
        : [],
    })
    return portOf(
      (m) => {
        worker.postMessage(m)
      },
      (receive) => {
        worker.on('message', receive)
        worker.on('error', (error: Error) => {
          receive(error)
        })
      },
      () => {
        void worker.terminate()
      },
    )
  }
  if (typeof Worker === 'undefined') return null
  const bridge = typeof SharedArrayBuffer === 'undefined' ? await serviceWorkerBridge() : undefined
  if (bridge === null) return null
  // The worker starts from the bundle core embeds, as pyodide's does: a
  // bundler that moves this module leaves no file a relative URL finds.
  const { default: source } = await import('../../generated/wasm_worker.ts')
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  const worker = new Worker(url, { type: 'module' })
  return portOf(
    (m) => {
      worker.postMessage(m)
    },
    (receive) => {
      worker.onmessage = (event: MessageEvent<Message>) => {
        receive(event.data)
      }
      worker.onerror = (event) => {
        receive(new Error(event.message || 'its script did not start'))
      }
    },
    () => {
      worker.terminate()
      URL.revokeObjectURL(url)
    },
    bridge,
  )
}

/** A row as it crosses to the guest: its original backend row stays here. */
function crossing(row: VFSStat | null): VFSStat | null {
  if (row === null) return null
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'source')) as VFSStat
}

/**
 * Compile-once, run-many WASI module, each run on a worker. Mirrors
 * Python's `WasmExecution`: the module compiles once, each request runs
 * on a worker of its own (an idle one when there is), and a stopped run
 * ends its worker, the only way to stop a guest that never calls out.
 *
 * Filesystem imports are answered here: every fd and path call the guest
 * makes lands in its `WasiFs`, whose view and open files are this run's
 * `WasmView` and its descriptors, so the run sees exactly what the view
 * serves, only the passed environment, and no network.
 *
 * @param source - the module's bytes.
 * @param trapPrefix - the command name a wasm trap's stderr line starts with.
 */
export class WasmExecution {
  private compiled: Promise<WebAssembly.Module> | null = null
  private idle: Port[] = []
  private closed = false

  constructor(
    private readonly source: () => Promise<Uint8Array>,
    private readonly trapPrefix: string,
  ) {}

  /** The compiled module; a load that failed is tried again on the next run. */
  private module(): Promise<WebAssembly.Module> {
    this.compiled ??= this.source()
      .then((bytes) => WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>))
      .catch((error: unknown) => {
        this.compiled = null
        throw error
      })
    return this.compiled
  }

  /**
   * Run the module once and return `[stdout, stderr, exitCode]`. A guest
   * write to a stream with a sink waits until the sink takes it, so a
   * reader that falls behind holds the guest back, as a full pipe would;
   * that stream then comes back empty. A stop ends the guest where it is:
   * the files it left open land, and the run rejects with the stop.
   *
   * @param argv - full argv, the program name included.
   * @param stdin - the run's input, which the guest takes as it reads it.
   * @param env - the environment as `[name, value]` pairs.
   * @param view - the files the guest sees.
   * @param output - receives stdout as the guest writes it; absent returns it.
   * @param errors - the same for stderr.
   * @param stop - ends the run.
   */
  async run(
    argv: string[],
    stdin: ByteSource | null,
    env: [string, string][],
    view: WasmView,
    output?: OutputFn,
    errors?: OutputFn,
    stop?: AbortSignal,
  ): Promise<[Uint8Array, Uint8Array | null, number]> {
    this.checkOpen()
    const module = await abortable(this.module(), stop)
    const port = this.idle.pop() ?? (await this.started(stop))
    const reader = stdin === null ? null : new AsyncLineIterator(stdin)
    const kept: [Uint8Array[], Uint8Array[]] = [[], []]
    const open = new Map<number, Descriptor>()
    const buffers = new Set<SharedArrayBuffer>()
    const answers = new Set<Promise<void>>()
    // A call still waiting when the run ends (input that has not come)
    // ends with it.
    const ended = new AbortController()
    const halt = stop === undefined ? ended.signal : AbortSignal.any([stop, ended.signal])
    const state = { stopped: false }
    const operation = async (call: GuestCall): Promise<unknown> => {
      const args = call.args ?? []
      switch (call.op) {
        // The view's files stop with the run, and the run's end waits for
        // a call under way, as Python's abort joins it, so a file it
        // opens is among those the end lands.
        case 'view':
          return this.viewCall(view, open, call.method ?? '', args)
        case 'file':
          return this.fileCall(open, call.file ?? -1, call.method ?? '', args)
        case 'stdin':
          return reader === null
            ? new Uint8Array()
            : abortable(reader.read1(args[0] as number), halt)
        case 'output': {
          const fd = args[0] === 2 ? 2 : 1
          const bytes = args[1] as Uint8Array
          const sink = fd === 1 ? output : errors
          if (sink === undefined) {
            ;(fd === 1 ? kept[0] : kept[1]).push(bytes)
            return true
          }
          try {
            await abortable(sink(bytes), halt)
            return true
          } catch (error) {
            if (halt.aborted) throw error
            // A reader that went away fails the guest's write with EPIPE.
            console.debug(`${this.trapPrefix}: the reader went away: ${String(error)}`)
            return false
          }
        }
        case 'sleep':
          return sleep(args[0] as number, halt).then(
            () => false,
            () => true,
          )
      }
    }
    let fail = (error: Error): void => {
      throw error
    }
    const answer = (message: GuestCall & BridgeCall): void => {
      if (message.buffer !== undefined) buffers.add(message.buffer)
      const work = (): Promise<unknown> => operation(message)
      const done =
        message.buffer !== undefined
          ? respond(message.buffer, work)
          : answerOverBridge(port.bridge ?? '', message.id ?? '', work)
      const settled: Promise<void> = done
        .catch((error: unknown) => {
          // An answer that cannot reach the guest leaves it waiting forever.
          fail(error instanceof Error ? error : new Error(failureText(error)))
        })
        .finally(() => {
          answers.delete(settled)
          if (message.buffer !== undefined) buffers.delete(message.buffer)
        })
      answers.add(settled)
    }
    let end = (): void => undefined
    const result = new Promise<Extract<GuestReply, { kind: 'result' }>>((resolve, reject) => {
      fail = (error) => {
        state.stopped = true
        port.terminate()
        reject(error)
      }
      port.listen((message) => {
        if (message instanceof Error) reject(message)
        else if (message.kind === 'vfs') answer(message)
        else if (message.kind === 'result') resolve(message)
        else if (message.kind === 'error') reject(new Error(message.message))
      })
      end = () => {
        state.stopped = true
        port.terminate()
        // A call the guest waits on never sees its answer now.
        for (const buffer of buffers) {
          const cells = new Int32Array(buffer, 0, 4)
          Atomics.store(cells, 0, -1)
          Atomics.notify(cells, 0)
        }
        reject(makeAbortError(stop))
      }
    })
    if (stop?.aborted === true) end()
    else stop?.addEventListener('abort', end, { once: true })
    try {
      port.post({
        module,
        argv,
        env: env.map(([name, value]) => `${name}=${value}`),
        piped: stdin !== null,
        ...(port.bridge !== undefined ? { bridge: port.bridge } : {}),
      } satisfies GuestRun)
      const done = await result
      let stderr = concat(kept[1])
      const lines = [...(done.trap === null ? [] : [done.trap]), ...done.lost]
      if (lines.length > 0)
        stderr = concat([
          stderr,
          new TextEncoder().encode(lines.map((line) => `${this.trapPrefix}: ${line}\n`).join('')),
        ])
      const exitCode = done.lost.length > 0 && done.exitCode === 0 ? 1 : done.exitCode
      return [concat(kept[0]), stderr.byteLength > 0 ? stderr : null, exitCode]
    } catch (error) {
      // A worker that failed is not reused.
      state.stopped = true
      throw error
    } finally {
      stop?.removeEventListener('abort', end)
      ended.abort()
      await Promise.all(answers)
      // A stopped guest left its files open; what they wrote still lands,
      // as a killed process's writes are in its files. A landing that fails
      // has no one left to tell.
      for (const file of open.values()) {
        try {
          await file.close()
        } catch (error) {
          console.debug(`${this.trapPrefix}: landing an open file failed: ${String(error)}`)
        }
      }
      if (state.stopped || this.closed) port.terminate()
      else this.idle.push(port)
    }
  }

  private checkOpen(): void {
    if (this.closed) throw new Error('WASM execution is closed')
  }

  /** A started worker, or the stop; one that starts after the stop goes. */
  private async started(stop?: AbortSignal): Promise<Port> {
    const starting = this.ready()
    try {
      return await abortable(starting, stop)
    } catch (error) {
      if (stop?.aborted === true)
        void starting.then(
          (port) => {
            port.terminate()
          },
          (failure: unknown) => {
            console.debug(`${this.trapPrefix}: a stopped run's worker failed: ${String(failure)}`)
          },
        )
      throw error
    }
  }

  /** A started worker, listening. */
  private async ready(): Promise<Port> {
    const port = await startWorker()
    if (port === null) throw new Error(NO_WORKER)
    await new Promise<void>((resolve, reject) => {
      port.listen((message) => {
        if (message instanceof Error) reject(message)
        else if (message.kind === 'ready') resolve()
      })
    })
    return port
  }

  private async viewCall(
    view: WasmView,
    open: Map<number, Descriptor>,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const path = args[0] as string
    switch (method) {
      case 'stat':
        return crossing(await view.stat(path))
      case 'lstat':
        return crossing(await view.lstat(path))
      case 'statOrNull':
        return crossing(await view.statOrNull(path, args[1] === true))
      case 'open': {
        const file = await view.open(path, args[1] as OpenMode)
        open.set(file.fd, file)
        return { id: file.fd, opened: file.opened, inode: file.inode }
      }
      case 'unlink':
        return view.unlink(path)
      case 'mkdir':
        return view.mkdir(path)
      case 'rmdir':
        return view.rmdir(path)
      case 'rename':
        return view.rename(path, args[1] as string)
      case 'symlink':
        return view.symlink(path, args[1] as string)
      case 'walked':
        return view.walked(path, args[1] !== false)
      case 'readlink':
        return view.readlink(path)
      case 'setattr':
        return view.setattr(
          path,
          args[1] as string | null,
          args[2] as string | null,
          args[3] === true,
        )
      case 'readdir':
        return view.readdir(path)
    }
    throw new Error(`unknown view call: ${method}`)
  }

  private async fileCall(
    open: Map<number, Descriptor>,
    id: number,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const file = open.get(id)
    if (file === undefined) throw new Error(`no open file ${String(id)}`)
    switch (method) {
      case 'path':
        return file.path
      case 'position':
        return file.pos
      case 'size':
        return file.size()
      case 'read':
        return file.read(args[0] as number)
      case 'pread':
        return file.pread(args[0] as number, args[1] as number)
      case 'write':
        return file.write(args[0] as Uint8Array)
      case 'pwrite':
        return file.pwrite(args[0] as number, args[1] as Uint8Array)
      case 'seek':
        return file.seek(args[0] as number, args[1] as number)
      case 'truncate':
        return file.truncate(args[0] as number)
      case 'land':
        return file.land()
      case 'close':
        open.delete(id)
        return file.close()
      case 'fstat':
        return crossing(await file.files.fstat(file.fd))
      case 'unlinked':
        return file.files.unlinked(file.fd)
    }
    throw new Error(`unknown file call: ${method}`)
  }

  /** Let the idle workers go. */
  close(): Promise<void> {
    this.closed = true
    for (const port of this.idle) port.terminate()
    this.idle = []
    return Promise.resolve()
  }
}
