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

import type { RunArgs, RunResult } from '../runtime.ts'
import {
  createMirageBridge,
  type BridgeDispatchFn,
  type MirageBridge,
} from '../python/mirage_bridge.ts'
import { QUICKJS_RUNTIME, type JsRuntime, type JsRuntimeOptions } from './interface.ts'
import { installMirageFs, MIRAGE_FS_BOOTSTRAP } from './mirage_fs.ts'
import { QuickJsUnavailableError } from './types.ts'
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

// Assembles the std/console/scriptArgs surface from injected primitives.
// Kept identical to the quickjs-ng `--std` globals the Python runtime
// exposes, so a script runs the same on both: `std.in.readAsString()`,
// `std.exit()`, `console.log`, `scriptArgs`. `std.open`/`os.readdir` are
// added afterward by MIRAGE_FS_BOOTSTRAP when a workspace bridge is wired.
const BOOTSTRAP = `
const __fmt = (v) =>
  typeof v === 'string' ? v
  : (v !== null && typeof v === 'object' ? (() => { try { return JSON.stringify(v) } catch { return String(v) } })() : String(v));
const __join = (a) => a.map(__fmt).join(' ');
globalThis.console = {
  log: (...a) => __mirage_log(__join(a)),
  info: (...a) => __mirage_log(__join(a)),
  debug: (...a) => __mirage_log(__join(a)),
  error: (...a) => __mirage_error(__join(a)),
  warn: (...a) => __mirage_error(__join(a)),
};
globalThis.std = {
  in: { readAsString: () => __mirage_stdin },
  out: { puts: (s) => __mirage_log(String(s)), print: (s) => __mirage_log(String(s)) },
  err: { puts: (s) => __mirage_error(String(s)) },
  exit: (n) => { __mirage_setExit(n | 0); throw new Error('__mirage_exit'); },
  getenv: (k) => __mirage_env[k],
};
`

// quickjs-emscripten bundles its own wasm, so the `home` option the
// config accepts (for parity with the Python quickjs runtime, which
// locates qjs-wasi.wasm) has nothing to locate here and is ignored. The
// asyncify variant is used so `std.open`/`os.readdir` can suspend the
// guest while a workspace-mount read or write awaits the dispatch,
// matching the Python runtime's live file I/O.
export class QuickJsRuntime implements JsRuntime {
  readonly name = QUICKJS_RUNTIME
  static readonly commands: readonly string[] = ['node', 'js'] as const
  readonly captures = QuickJsRuntime.commands
  private newAsyncModule: NewAsyncModule | null = null
  private workspaceBridge: BridgeDispatchFn | null
  private listMounts: () => string[]

  constructor(options: JsRuntimeOptions = {}) {
    this.workspaceBridge = options.workspaceBridge ?? null
    this.listMounts = options.listMounts ?? ((): string[] => [])
  }

  attach(dispatch: BridgeDispatchFn, listMounts: () => string[]): void {
    if (this.workspaceBridge === null) {
      this.workspaceBridge = dispatch
      this.listMounts = listMounts
    }
  }

  async run(args: RunArgs): Promise<RunResult> {
    const newAsyncModule = await this.loadModule()
    const QuickJS = await newAsyncModule()
    const runtime: QuickJSAsyncRuntime = QuickJS.newRuntime()
    runtime.setMemoryLimit(MEMORY_LIMIT)
    runtime.setMaxStackSize(STACK_SIZE)
    const ctx = runtime.newContext()
    const out: string[] = []
    const err: string[] = []
    const exit = { code: 0, called: false }
    try {
      this.installGlobals(ctx, args, out, err, exit)
      const bridge: MirageBridge | null =
        this.workspaceBridge !== null
          ? createMirageBridge(this.workspaceBridge, this.listMounts)
          : null
      installMirageFs(ctx, bridge)

      const boot = ctx.evalCode(BOOTSTRAP + MIRAGE_FS_BOOTSTRAP, 'mirage:bootstrap')
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
        if (exit.called) {
          exitCode = exit.code
        } else {
          err.push(this.formatError(ctx, result.error))
          exitCode = 1
        }
        result.error.dispose()
      } else {
        result.value.dispose()
        const drained = this.drainJobs(runtime, ctx, err)
        if (drained !== null) exitCode = exit.called ? exit.code : drained
      }
      return {
        stdout: ENC.encode(out.map((l) => l + '\n').join('')),
        stderr: err.length > 0 ? ENC.encode(err.map((l) => l + '\n').join('')) : null,
        exitCode,
      }
    } finally {
      ctx.dispose()
      runtime.dispose()
    }
  }

  close(): Promise<void> {
    // Each run disposes its own runtime/context; nothing persists.
    return Promise.resolve()
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
    args.args.forEach((a, i) => {
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
        err.push(this.formatError(ctx, jobs.error))
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
