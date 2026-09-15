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

import { CommandTimeoutError } from '../../../commands/errors.ts'
import { HOME_CONFIG_KEYS } from '../../config.ts'
import { EvalError } from '../../errors.ts'
import { JsRuntime } from '../base.ts'
import { EVALUATOR, type Evaluator } from '../../mixin.ts'
import type {
  EvalResult,
  EvalValue,
  RunArgs,
  RunResult,
  RuntimeOptions,
  RuntimeContext,
} from '../../types.ts'
import { RuntimeVFS } from '../../vfs.ts'
import { installMirageFs } from './vfs.ts'
import BOOTSTRAP from '../../../generated/quickjs.ts'
import { QuickJsUnavailableError } from './errors.ts'
import type {
  QuickJSAsyncContext,
  QuickJSAsyncRuntime,
  QuickJSAsyncWASMModule,
  QuickJSHandle,
} from 'quickjs-emscripten'

type NewAsyncModule = () => Promise<QuickJSAsyncWASMModule>

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

const MEMORY_LIMIT = 64 * 1024 * 1024
const STACK_SIZE = 1024 * 1024

// One-shot evals (the policy engine, console evals) are bounded by the
// VM interrupt because a busy loop blocks the host timer (matches the
// policy evaluation timeout in decide.ts).
const EVAL_INTERRUPT_SECONDS = 10

// quickjs-emscripten bundles its own wasm, so the HomeConfig `home`
// key (for parity with the Python quickjs runtime, which locates
// qjs-wasi.wasm) has nothing to locate here and is ignored.

// The asyncify variant is used so `std.open`/`os.readdir` can suspend
// the guest while a workspace-mount read or write awaits the dispatch,
// matching the Python runtime's live file I/O.
export class QuickJsRuntime extends JsRuntime implements Evaluator {
  readonly name = 'quickjs'
  // The engine is a WASI guest whose `std.open`/`os.readdir` suspend
  // into the workspace bridge: guest I/O has no door around the gate.
  override readonly reach = 'vfs'
  override readonly filesystem = ['read', 'write', 'list', 'stat'] as const
  readonly [EVALUATOR] = true as const
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

  protected override executeCode(args: RunArgs, context?: RuntimeContext): Promise<RunResult> {
    return this.run(args, context)
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
    const timedOut = this.installInterrupt(runtime, args.signal, args.timeoutSeconds)
    try {
      this.installGlobals(ctx, args, out, err, exit)
      const vfs = context !== undefined ? new RuntimeVFS(context.dispatch, context.resolver) : null
      installMirageFs(ctx, vfs)

      const boot = ctx.evalCode(BOOTSTRAP, 'mirage:bootstrap')
      if (boot.error) {
        boot.error.dispose()
        throw new Error('quickjs bootstrap failed')
      }
      boot.value.dispose()

      const result = await ctx.evalCodeAsync(
        args.code,
        args.flags?.module === true ? 'input.mjs' : 'input.js',
        {
          type: args.flags?.module === true ? 'module' : 'global',
        },
      )
      let exitCode = 0
      if (result.error) {
        if (timedOut.value && args.timeoutSeconds !== undefined) {
          result.error.dispose()
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
        result.value.dispose()
        const drained = this.drainJobs(runtime, ctx, err)
        if (drained !== null) exitCode = exit.called ? exit.code : drained
      }
      return {
        stdout: ENC.encode(out.join('')),
        stderr: err.length > 0 ? ENC.encode(err.join('')) : null,
        exitCode,
      }
    } finally {
      ctx.dispose()
    }
  }

  /**
   * Evaluate one JS program; the completion value is the value.
   *
   * Inputs bind as globals and the source runs at global scope, so the
   * LAST EXPRESSION is the value (what the policy engine consumes for
   * JS policy scripts). Each eval is a fresh engine, mirroring the
   * python wasi runtime, so console sessions are not supported.
   */
  async eval(
    code: string,
    opts: { inputs?: Record<string, EvalValue>; session?: string } = {},
  ): Promise<EvalResult> {
    const context = this.captureContext()
    if (opts.session !== undefined) {
      throw new EvalError(
        'the quickjs evaluator is one-shot only: each eval is a fresh ' +
          'engine, so console sessions are unsupported',
      )
    }
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
    // Bounded like a policy evaluation must be: a looping script would
    // otherwise block the event loop with no timer able to fire.
    const timedOut = this.installInterrupt(runtime, undefined, EVAL_INTERRUPT_SECONDS)
    try {
      this.installGlobals(ctx, { code, args: [], env: {}, stdin: null, flags: {} }, out, err, {
        code: 0,
        called: false,
      })
      // Same filesystem surface as run(): an attached workspace serves
      // std.open/os.readdir, so a JS policy script can read mounted
      // content (the python evaluator gets this via run()'s RuntimeVFS).
      const vfs = context !== undefined ? new RuntimeVFS(context.dispatch, context.resolver) : null
      installMirageFs(ctx, vfs)
      const boot = ctx.evalCode(BOOTSTRAP, 'mirage:bootstrap')
      if (boot.error) {
        boot.error.dispose()
        throw new EvalError('quickjs bootstrap failed')
      }
      boot.value.dispose()
      const inputsJson = JSON.stringify(opts.inputs ?? {})
      const bind = ctx.evalCode(
        `for (const [__k, __v] of Object.entries(JSON.parse(${JSON.stringify(inputsJson)}))) globalThis[__k] = __v`,
        'mirage:inputs',
      )
      if (bind.error) {
        bind.error.dispose()
        throw new EvalError('quickjs eval could not bind inputs')
      }
      bind.value.dispose()
      const result = await ctx.evalCodeAsync(code, 'eval.js', { type: 'global' })
      if (result.error) {
        const message = this.formatError(ctx, result.error)
        result.error.dispose()
        if (timedOut.value) {
          throw new EvalError(`quickjs eval timed out after ${String(EVAL_INTERRUPT_SECONDS)}s`)
        }
        throw new EvalError(message, { syntax: message.startsWith('SyntaxError') })
      }
      const dumped: unknown = ctx.dump(result.value)
      result.value.dispose()
      const drained = this.drainJobs(runtime, ctx, err)
      if (drained !== null && drained !== 0) {
        throw new EvalError(err.join('').trim() || 'quickjs eval failed while draining jobs')
      }
      return {
        value: (dumped === undefined ? null : dumped) as EvalValue,
        stdout: ENC.encode(out.join('')),
        stderr: err.length > 0 ? ENC.encode(err.join('')) : null,
        exitCode: 0,
        status: 'complete',
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
  ): { value: boolean } {
    const timedOut = { value: false }
    const deadline =
      timeoutSeconds !== undefined && timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : null
    if (signal === undefined && deadline === null) return timedOut
    runtime.setInterruptHandler(() => {
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
        sink.push(ctx.getString(h))
      })
    setGlobal('__mirage_log', hostLog(out))
    setGlobal('__mirage_error', hostLog(err))
    setGlobal(
      '__mirage_setExit',
      ctx.newFunction('', (h) => {
        exit.code = Number(ctx.dump(h)) | 0
        exit.called = true
      }),
    )
    const stdin = args.stdin !== null ? DEC.decode(args.stdin) : ''
    setGlobal('__mirage_stdin', ctx.newString(stdin))
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

  private drainJobs(
    runtime: QuickJSAsyncRuntime,
    ctx: QuickJSAsyncContext,
    err: string[],
  ): number | null {
    for (;;) {
      const jobs = runtime.executePendingJobs()
      if (jobs.error) {
        err.push(this.formatError(ctx, jobs.error) + '\n')
        jobs.error.dispose()
        return 1
      }
      if (jobs.value <= 0) return 0
    }
  }

  private formatError(ctx: QuickJSAsyncContext, handle: QuickJSHandle): string {
    const readStr = (key: string): string | undefined => {
      const p = ctx.getProp(handle, key)
      const value: unknown = ctx.dump(p)
      p.dispose()
      return typeof value === 'string' ? value : undefined
    }
    const name = readStr('name') ?? 'Error'
    const message = readStr('message') ?? readStr('stack') ?? 'error'
    return `${name}: ${message}`
  }

  private async loadModule(): Promise<NewAsyncModule> {
    if (this.newAsyncModule !== null) return this.newAsyncModule
    try {
      const mod = (await import('quickjs-emscripten')) as unknown as {
        newQuickJSAsyncWASMModule: NewAsyncModule
      }
      this.newAsyncModule = mod.newQuickJSAsyncWASMModule
    } catch (err) {
      throw new QuickJsUnavailableError(
        "the quickjs runtime requires the 'quickjs-emscripten' package — install it to run `node`/`js`",
        { cause: err },
      )
    }
    return this.newAsyncModule
  }
}
