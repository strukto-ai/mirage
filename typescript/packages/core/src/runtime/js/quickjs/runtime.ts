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

import type { Context } from '../../../commands/config.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import { HOME_CONFIG_KEYS, type RuntimeOptions } from '../../config.ts'
import { JsRuntime } from '../base.ts'
import type { OutputFn, Program, RunResult } from '../../types.ts'
import { materialize } from '../../../io/types.ts'
import { abortable, fireDue, mergeSignals } from '../../../utils/abort.ts'
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
export class QuickJsRuntime extends JsRuntime<NewAsyncModule> {
  readonly name = 'quickjs'
  // The engine's `std.open`/`os.readdir` suspend (asyncify) into the
  // workspace bridge: guest I/O has no way around the gate.
  override readonly reach = 'workspace'
  override readonly filesystem = ['read', 'write', 'list', 'stat'] as const

  constructor(options: RuntimeOptions = {}) {
    super(options, HOME_CONFIG_KEYS)
  }

  /** The asyncify module factory; each run builds its own module from it. */
  protected override openEngine(): Promise<NewAsyncModule> {
    return loadQuickJsModule()
  }

  override async version(): Promise<RunResult> {
    const newAsyncModule = await this.engine()
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

  /**
   * Run one program on a fresh module of the install's engine.
   *
   * @param newAsyncModule the install's module factory.
   * @param program the source and argv to run.
   * @param ctx the run's context.
   * @param output receives stdout as it is written; absent returns it in
   *   the result.
   * @param errors the same for stderr.
   */
  async interpret(
    newAsyncModule: NewAsyncModule,
    program: Program,
    ctx: Context,
    output?: OutputFn,
    errors?: OutputFn,
  ): Promise<RunResult> {
    // Read through the run's signal: input left open must not hold back
    // the stop of a run that is cancelled or past its deadline.
    const stdin =
      program.stdin === null
        ? new Uint8Array()
        : await abortable(materialize(program.stdin), ctx.signal)
    const QuickJS = await newAsyncModule()
    // Module-owned context, not newRuntime(): the async module's runtime
    // disposer unregisters callbacks before QTS_FreeRuntime, so a runtime
    // that ever defined an asyncified host fn throws on dispose
    // (justjake/quickjs-emscripten#261). newContext() hands the runtime
    // to the context as an owned lifetime, which tears down in the safe
    // order; vm.dispose() ends both.
    const vm = QuickJS.newContext()
    const runtime: QuickJSAsyncRuntime = vm.runtime
    runtime.setMemoryLimit(MEMORY_LIMIT)
    runtime.setMaxStackSize(STACK_SIZE)
    const out: string[] = []
    const err: string[] = []
    const exit = { code: 0, called: false }
    // The guest executes on this event loop, so a busy loop blocks the
    // limit timer itself: the VM's interrupt hook is the only thing
    // that can still fire (python's epoch interruption on a thread).
    const timedOut = this.installInterrupt(runtime, ctx.signal, ctx.timeoutSeconds, exit)
    try {
      // A guest waiting on a slow reader is suspended, out of the hook's
      // reach, so the deadline also runs as a timer that stops the wait:
      // whole milliseconds, at most the longest delay a timer takes.
      const deadline =
        ctx.timeoutSeconds !== undefined && ctx.timeoutSeconds > 0
          ? AbortSignal.timeout(Math.min(Math.ceil(ctx.timeoutSeconds * 1000), 2 ** 31 - 1))
          : undefined
      this.installGlobals(
        vm,
        program,
        stdin,
        ctx,
        exit,
        [out, output],
        [err, errors],
        mergeSignals(ctx.signal, deadline),
      )
      const files = RuntimeFiles.of(ctx, this.binding)
      const closeAll = installQuickJsFs(vm, files, ctx.signal)

      const boot = vm.evalCode(`(() => { ${BOOTSTRAP} })()`, 'mirage:bootstrap')
      if (boot.error) {
        boot.error.dispose()
        throw new Error('quickjs bootstrap failed')
      }
      boot.value.dispose()

      let result = await vm.evalCodeAsync(cwdPreamble(ctx.cwd), 'mirage:cwd')
      if (!result.error) {
        result.value.dispose()
        result = await vm.evalCodeAsync(
          program.code,
          ctx.flags.module === true ? 'input.mjs' : 'input.js',
          {
            type: ctx.flags.module === true ? 'module' : 'global',
          },
        )
      }
      let exitCode = 0
      if (result.error) {
        if (exit.called) {
          exitCode = exit.code
        } else {
          // A cancelled run's interruption is no error of the program's:
          // it ends as a killed one does, saying nothing, as Monty's does.
          if (ctx.signal?.aborted !== true) err.push(this.formatError(vm, result.error) + '\n')
          exitCode = 1
        }
        result.error.dispose()
      } else {
        exitCode = await this.drainJobs(runtime, vm, err, exit, ctx.signal)
        // A module's evaluation is a promise, so a throw after a top-level
        // await rejects it rather than failing the eval; a script's last
        // value is the promise of the async call it ends with (`main()`).
        // The library has no rejection tracker, so a promise a script
        // drops before its end goes unreported.
        const state = vm.getPromiseState(result.value)
        if (state.type === 'rejected') {
          if (!exit.called) {
            const label = ctx.flags.module === true ? '' : 'Possibly unhandled promise rejection: '
            if (ctx.signal?.aborted !== true)
              err.push(label + this.formatError(vm, state.error) + '\n')
            exitCode = 1
          }
          state.error.dispose()
        } else if (state.type === 'fulfilled' && state.value !== result.value) {
          state.value.dispose()
        }
        if (exit.called) exitCode = exit.code
        result.value.dispose()
      }
      // Past the deadline is a timeout however the run ended, a queued job
      // it was running included.
      if ((timedOut.value || deadline?.aborted === true) && ctx.timeoutSeconds !== undefined) {
        await closeAll()
        throw new CommandTimeoutError(this.name, ctx.timeoutSeconds)
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
      vm.dispose()
    }
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
      // No timer runs while the guest holds the event loop, so a deadline
      // past (a `timeout` around the run) fires here, aborting the signal.
      fireDue()
      if (deadline !== null && Date.now() > deadline) {
        timedOut.value = true
        return true
      }
      return signal?.aborted === true
    })
    return timedOut
  }

  /**
   * Define the host side of the bootstrap's globals. A stream with a sink
   * suspends the guest on each write until the sink takes it, so a reader
   * that falls behind holds the program back; one without keeps what is
   * written for the result.
   */
  private installGlobals(
    ctx: QuickJSAsyncContext,
    program: Program,
    stdin: Uint8Array,
    run: Context,
    exit: { code: number; called: boolean },
    out: [string[], OutputFn | undefined],
    err: [string[], OutputFn | undefined],
    stop: AbortSignal | undefined,
  ): void {
    const setGlobal = (name: string, handle: QuickJSHandle): void => {
      ctx.setProp(ctx.global, name, handle)
      handle.dispose()
    }
    const hostLog = ([kept, sink]: [string[], OutputFn | undefined]): QuickJSHandle =>
      sink === undefined
        ? ctx.newFunction('', (h) => {
            run.signal?.throwIfAborted()
            kept.push(fromGuestText(ctx, h))
          })
        : ctx.newAsyncifiedFunction('', async (h) => {
            if (exit.called) return
            run.signal?.throwIfAborted()
            // A reader that went away ends the program at once, 141, as
            // SIGPIPE ends one.
            await abortable(sink(ENC.encode(fromGuestText(ctx, h))), stop).catch(
              (error: unknown) => {
                if (stop?.aborted === true) {
                  // Stopped while it waited: the program ends at its next
                  // step, as an interrupted one does.
                  exit.code = 1
                  exit.called = true
                  return
                }
                console.debug(`${this.name}: the reader went away: ${String(error)}`)
                exit.code = 141
                exit.called = true
              },
            )
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
    let position = 0
    setGlobal(
      '__mirage_readStdin',
      ctx.newFunction('', (max) => {
        run.signal?.throwIfAborted()
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
    const scriptArgs = program.prog !== undefined ? [program.prog, ...program.args] : program.args
    scriptArgs.forEach((a, i) => {
      const s = ctx.newString(a)
      ctx.setProp(argv, i, s)
      s.dispose()
    })
    setGlobal('scriptArgs', argv)
    const env = ctx.newObject()
    for (const [k, v] of Object.entries(run.env ?? {})) {
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
    signal: AbortSignal | undefined,
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
        // A cancelled run's interruption is no error of the program's.
        if (!exit.called && signal?.aborted !== true) err.push(this.formatError(ctx, jobs) + '\n')
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
}
