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

import { CommandTimeoutError } from '../../../errors/types.ts'
import { HOME_CONFIG_KEYS, type RuntimeOptions } from '../../config.ts'
import { JsRuntime } from '../base.ts'
import type { RunArgs, RunResult } from '../../types.ts'
import { RuntimeFiles } from '../../files.ts'
import { fromGuestText, installQuickJsFs, toGuestText } from './fs.ts'
import { cwdPreamble } from './execution.ts'
import BOOTSTRAP from '../../../generated/quickjs.ts'
import { loadQuickJsModule, type NewAsyncModule } from './loader.ts'
import type { QuickJSAsyncContext, QuickJSAsyncRuntime, QuickJSHandle } from 'quickjs-emscripten'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

const MEMORY_LIMIT = 64 * 1024 * 1024
const STACK_SIZE = 1024 * 1024

// quickjs-emscripten bundles its own wasm, so the HomeConfig `home`
// key (for parity with the Python quickjs runtime, which locates
// qjs-wasi.wasm) has nothing to locate here and is ignored.

// The asyncify variant is used so `std.open`/`os.readdir` can suspend
// the guest while a workspace-mount read or write awaits the dispatch,
// matching the Python runtime's live file I/O.
export class QuickJsRuntime extends JsRuntime {
  readonly name = 'quickjs'
  // The engine's `std.open`/`os.readdir` suspend (asyncify) into the
  // workspace bridge: guest I/O has no way around the gate.
  override readonly reach = 'workspace'
  override readonly filesystem = ['read', 'write', 'list', 'stat'] as const
  private newAsyncModule: NewAsyncModule | null = null

  constructor(options: RuntimeOptions = {}) {
    super(options, HOME_CONFIG_KEYS)
  }

  override async version(): Promise<RunResult> {
    const newAsyncModule = await this.loadModule()
    const QuickJS = await newAsyncModule()
    const ctx = QuickJS.newContext()
    try {
      // JS_DumpMemoryUsage prints the engine's compiled-in version.
      const version = /^QuickJS memory usage -- (\S+) version,/.exec(
        ctx.runtime.dumpMemoryUsage(),
      )?.[1]
      if (version === undefined) throw new Error('could not read the QuickJS engine version')
      return {
        stdout: ENC.encode(`JavaScript (quickjs ${version})\n`),
        stderr: null,
        exitCode: 0,
      }
    } finally {
      ctx.dispose()
    }
  }

  async run(args: RunArgs, context = this.captureContext()): Promise<RunResult> {
    const newAsyncModule = await this.loadModule()
    const QuickJS = await newAsyncModule()
    // Module-owned context, not newRuntime(): the async module's runtime
    // disposer unregisters callbacks before QTS_FreeRuntime, so a runtime
    // that ever defined an asyncified host fn throws on dispose
    // (justjake/quickjs-emscripten#261). newContext() hands the runtime
    // to the context as an owned lifetime, which tears down in the safe
    // order; ctx.dispose() ends both.
    const ctx = QuickJS.newContext()
    const runtime: QuickJSAsyncRuntime = ctx.runtime
    runtime.setMemoryLimit(MEMORY_LIMIT)
    runtime.setMaxStackSize(STACK_SIZE)
    const out: string[] = []
    const err: string[] = []
    const exit = { code: 0, called: false }
    // The guest executes on this event loop, so a busy loop blocks the
    // limit timer itself: the VM's interrupt hook is the only thing
    // that can still fire (python's epoch interruption on a thread).
    const timedOut = this.installInterrupt(runtime, args.signal, args.timeoutSeconds, exit)
    try {
      this.installGlobals(ctx, args, out, err, exit)
      const files = RuntimeFiles.of(context)
      const closeAll = installQuickJsFs(ctx, files)

      const boot = ctx.evalCode(`(() => { ${BOOTSTRAP} })()`, 'mirage:bootstrap')
      if (boot.error) {
        boot.error.dispose()
        throw new Error('quickjs bootstrap failed')
      }
      boot.value.dispose()

      let result = await ctx.evalCodeAsync(cwdPreamble(args.cwd ?? context?.cwd), 'mirage:cwd')
      if (!result.error) {
        result.value.dispose()
        result = await ctx.evalCodeAsync(
          args.code,
          args.flags?.module === true ? 'input.mjs' : 'input.js',
          {
            type: args.flags?.module === true ? 'module' : 'global',
          },
        )
      }
      let exitCode = 0
      if (result.error) {
        if (timedOut.value && args.timeoutSeconds !== undefined) {
          result.error.dispose()
          await closeAll()
          throw new CommandTimeoutError(this.name, args.timeoutSeconds)
        }
        if (exit.called) {
          exitCode = exit.code
        } else {
          err.push(this.formatError(ctx, result.error) + '\n')
          exitCode = 1
        }
        result.error.dispose()
      } else {
        exitCode = await this.drainJobs(runtime, ctx, err, exit)
        // A module's evaluation is a promise, so a throw after a top-level
        // await rejects it rather than failing the eval; a script's last
        // value is the promise of the async call it ends with (`main()`).
        // The library has no rejection tracker, so a promise a script
        // drops before its end goes unreported.
        const state = ctx.getPromiseState(result.value)
        if (state.type === 'rejected') {
          if (!exit.called) {
            const label =
              args.flags?.module === true ? '' : 'Possibly unhandled promise rejection: '
            err.push(label + this.formatError(ctx, state.error) + '\n')
            exitCode = 1
          }
          state.error.dispose()
        } else if (state.type === 'fulfilled' && state.value !== result.value) {
          state.value.dispose()
        }
        if (exit.called) exitCode = exit.code
        result.value.dispose()
      }
      // Files the guest left open still owe the mount their writes, however
      // the program ended.
      const lost = await closeAll()
      for (const line of lost) err.push(`${this.name}: ${line}\n`)
      if (lost.length > 0 && exitCode === 0) exitCode = 1
      return {
        stdout: ENC.encode(out.join('')),
        stderr: err.length > 0 ? ENC.encode(err.join('')) : null,
        exitCode,
      }
    } finally {
      ctx.dispose()
    }
  }

  override close(): Promise<void> {
    // Each run disposes its own runtime/context; nothing persists.
    return Promise.resolve()
  }

  /**
   * Arm the VM's interrupt hook: the only cancellation that works when
   * the guest blocks the event loop. Trips on the limit deadline
   * (recorded in the returned cell) or on an aborted signal.
   */
  private installInterrupt(
    runtime: QuickJSAsyncRuntime,
    signal: AbortSignal | undefined,
    timeoutSeconds: number | undefined,
    exit: { called: boolean },
  ): { value: boolean } {
    const timedOut = { value: false }
    const deadline =
      timeoutSeconds !== undefined && timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : null
    runtime.setInterruptHandler(() => {
      if (exit.called) return true
      if (deadline !== null && Date.now() > deadline) {
        timedOut.value = true
        return true
      }
      return signal?.aborted === true
    })
    return timedOut
  }

  private installGlobals(
    ctx: QuickJSAsyncContext,
    args: RunArgs,
    out: string[],
    err: string[],
    exit: { code: number; called: boolean },
  ): void {
    const setGlobal = (name: string, handle: QuickJSHandle): void => {
      ctx.setProp(ctx.global, name, handle)
      handle.dispose()
    }
    const hostLog = (sink: string[]): QuickJSHandle =>
      ctx.newFunction('', (h) => {
        sink.push(fromGuestText(ctx, h))
      })
    setGlobal(
      '__mirage_atob',
      ctx.newFunction('atob', (h) => toGuestText(ctx, atob(fromGuestText(ctx, h)))),
    )
    setGlobal(
      '__mirage_btoa',
      ctx.newFunction('btoa', (h) => toGuestText(ctx, btoa(fromGuestText(ctx, h)))),
    )
    setGlobal('__mirage_log', hostLog(out))
    setGlobal('__mirage_error', hostLog(err))
    setGlobal(
      '__mirage_setExit',
      ctx.newFunction('', (h) => {
        exit.code = Number(ctx.dump(h)) & 255
        exit.called = true
      }),
    )
    const stdin = args.stdin ?? new Uint8Array()
    let position = 0
    setGlobal(
      '__mirage_readStdin',
      ctx.newFunction('', (max) => {
        const count = ctx.getNumber(max)
        const end = count < 0 ? stdin.length : Math.min(stdin.length, position + count)
        const text = DEC.decode(stdin.subarray(position, end))
        position = end
        return toGuestText(ctx, text)
      }),
    )
    setGlobal(
      '__mirage_byteLength',
      ctx.newFunction('', (text) => ctx.newNumber(ENC.encode(fromGuestText(ctx, text)).length)),
    )
    const argv = ctx.newArray()
    // A named program takes scriptArgs[0], the slot qjs fills with a
    // script's path when it runs a file; an unnamed run leaves the args
    // alone, so the js command keeps its spelling.
    const scriptArgs = args.prog !== undefined ? [args.prog, ...args.args] : args.args
    scriptArgs.forEach((a, i) => {
      const s = ctx.newString(a)
      ctx.setProp(argv, i, s)
      s.dispose()
    })
    setGlobal('scriptArgs', argv)
    const env = ctx.newObject()
    for (const [k, v] of Object.entries(args.env)) {
      const s = ctx.newString(v)
      ctx.setProp(env, k, s)
      s.dispose()
    }
    setGlobal('__mirage_env', env)
  }

  /**
   * Run the jobs the program queued (promise reactions, async functions
   * past an `await`) until none are left, letting each suspend into the
   * file bridge as top-level code does. Mirrors the library's own
   * executePendingJobs over the call that can suspend: quickjs-emscripten
   * runs jobs through the bare QTS_ExecutePendingJob export (its cwrap
   * skips the asyncify wrapper for an all-number signature, its
   * `_MaybeAsync` twin included), so an asyncified host function called
   * from a job could not suspend, and a guest file call after an `await`
   * failed and dropped its job. The emscripten module's own `cwrap`, asked
   * for an async call, waits out a suspension.
   */
  private async drainJobs(
    runtime: QuickJSAsyncRuntime,
    ctx: QuickJSAsyncContext,
    err: string[],
    exit: { called: boolean },
  ): Promise<number> {
    type RuntimePointer = Parameters<QuickJSAsyncContext['getMemory']>[0]
    type ValuePointer = Parameters<
      ReturnType<QuickJSAsyncContext['getMemory']>['heapValueHandle']
    >[0]
    const engine = runtime as unknown as {
      rt: { value: RuntimePointer }
      module: {
        cwrap: (
          name: string,
          returns: 'number',
          args: 'number'[],
          opts: { async: true },
        ) => (rt: RuntimePointer, max: number, lastContext: number) => Promise<ValuePointer>
      }
      ffi: { QTS_FreeValuePointerRuntime: (rt: RuntimePointer, value: ValuePointer) => void }
    }
    const memory = ctx.getMemory(engine.rt.value)
    const executePendingJob = engine.module.cwrap(
      'QTS_ExecutePendingJob',
      'number',
      ['number', 'number', 'number'],
      { async: true },
    )
    for (;;) {
      const lastContext = memory.newMutablePointerArray(1)
      const done = await executePendingJob(engine.rt.value, -1, lastContext.value.ptr)
      const ran = lastContext.value.typedArray[0]
      lastContext.dispose()
      if (ran === 0) {
        engine.ffi.QTS_FreeValuePointerRuntime(engine.rt.value, done)
        return 0
      }
      const jobs = memory.heapValueHandle(done)
      if (ctx.typeof(jobs) !== 'number') {
        if (!exit.called) err.push(this.formatError(ctx, jobs) + '\n')
        jobs.dispose()
        return 1
      }
      const count = ctx.getNumber(jobs)
      jobs.dispose()
      if (count <= 0) return 0
    }
  }

  private formatError(ctx: QuickJSAsyncContext, handle: QuickJSHandle): string {
    const readStr = (key: string): string | undefined => {
      const p = ctx.getProp(handle, key)
      const value: unknown = ctx.dump(p)
      p.dispose()
      return typeof value === 'string' ? value : undefined
    }
    if (ctx.typeof(handle) !== 'object' || ctx.dump(handle) === null)
      return String(ctx.dump(handle))
    const name = readStr('name')
    const message = readStr('message')
    if (name === undefined && message === undefined) return String(ctx.dump(handle))
    return message ? `${name ?? 'Error'}: ${message}` : (name ?? 'Error')
  }

  private async loadModule(): Promise<NewAsyncModule> {
    this.newAsyncModule ??= await loadQuickJsModule()
    return this.newAsyncModule
  }
}
