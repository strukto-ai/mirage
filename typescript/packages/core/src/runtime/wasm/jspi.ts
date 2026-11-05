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

import type { ByteSource } from '../../io/types.ts'
import { INTERRUPTED_STATUS } from '../../shell/constants.ts'
import { abortable, makeAbortError } from '../../utils/abort.ts'
import { boundSystemClock, systemNow } from '../../utils/clock.ts'
import type { OutputFn } from '../types.ts'
import { type GuestCall, GuestHost } from './execution.ts'
import { drive, GuestExit, WasiFs, wasiImports } from './fs.ts'
import { guestView } from './guest.ts'
import { failureText } from './transport.ts'
import type { WasmView } from './view.ts'

// JavaScript Promise Integration, which the DOM and ES libs do not type yet.
interface Jspi {
  Suspending: new (call: (...args: never[]) => unknown) => object
  promising: (exported: unknown) => (...args: unknown[]) => Promise<unknown>
}

const jspi = WebAssembly as unknown as Partial<Jspi>

/** Whether this engine can suspend a wasm guest on a promise (JSPI). */
export function jspiAvailable(): boolean {
  return typeof jspi.Suspending === 'function' && typeof jspi.promising === 'function'
}

/**
 * Run-many WASI module whose guest runs in the host's own isolate: each
 * call it makes of the host hands JSPI a promise, which suspends the
 * guest's wasm stack until the host's loop answers, so the run needs no
 * worker and no shared memory. Where `WasmExecution` needs a thread to
 * block (an edge isolate has none), this needs only JSPI and a module
 * compiled ahead of time, since an edge runtime compiles no wasm.
 *
 * The guest holds the isolate's thread between its calls: a stop ends it
 * at the next call it makes, and one that never calls out runs on until
 * the host's own limit ends it.
 *
 * @param module - the compiled module.
 * @param trapPrefix - the command name a wasm trap's stderr line starts with.
 */
export class JspiExecution {
  private closed = false

  constructor(
    private readonly module: () => Promise<WebAssembly.Module>,
    private readonly trapPrefix: string,
  ) {}

  /**
   * Run the module once and return `[stdout, stderr, exitCode]`, as
   * `WasmExecution.run` does: a write to a stream with a sink waits until
   * the sink takes it, and a stop ends the guest at its next call, lands
   * the files it left open, and rejects with the stop.
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
    if (this.closed) throw new Error('WASM execution is closed')
    const { Suspending, promising } = jspi as Jspi
    const module = await abortable(this.module(), stop)
    // A call still waiting when the run ends (input that has not come)
    // ends with it.
    const ended = new AbortController()
    const halt = stop === undefined ? ended.signal : AbortSignal.any([stop, ended.signal])
    const host = new GuestHost(view, stdin, output, errors, halt, this.trapPrefix)
    const stopped = (): boolean => stop?.aborted === true
    // A stop ends the guest at the call it makes, as a signal ends a
    // process at its next syscall.
    const call = async (request: GuestCall): Promise<unknown> => {
      if (stopped()) throw new GuestExit(INTERRUPTED_STATUS)
      try {
        return await host.answer(request)
      } catch (error) {
        if (stopped()) throw new GuestExit(INTERRUPTED_STATUS)
        throw error
      }
    }
    const wasi = new WasiFs(
      guestView(call),
      stdin === null ? null : (size) => call({ op: 'stdin', args: [size] }) as Promise<Uint8Array>,
      (fd, bytes) => call({ op: 'output', args: [fd, bytes] }) as Promise<boolean>,
      (ms) => call({ op: 'sleep', args: [ms] }) as Promise<boolean>,
      argv,
      env.map(([name, value]) => `${name}=${value}`),
      boundSystemClock() === null ? 0 : systemNow() - Date.now() / 1000,
    )
    try {
      const instance = await WebAssembly.instantiate(
        module,
        wasiImports(wasi, (fn) => new Suspending(fn)),
      )
      wasi.memory = instance.exports.memory as WebAssembly.Memory
      let exitCode = 0
      let trap: string | null = null
      try {
        await promising(instance.exports._start)()
      } catch (err) {
        if (err instanceof GuestExit) exitCode = err.code
        else {
          exitCode = 1
          trap = `wasm trap: ${failureText(err)}`
        }
      }
      if (stopped()) throw makeAbortError(stop)
      return host.result({ exitCode, trap, lost: await drive(wasi.closeAll()) })
    } finally {
      ended.abort()
      // A stopped guest left its files open; what they wrote still lands.
      await host.land()
    }
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}
