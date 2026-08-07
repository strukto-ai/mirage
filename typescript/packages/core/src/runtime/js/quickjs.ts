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

import { CommandTimeoutError } from '../../commands/builtin/utils/limit.ts'
import { EvalError } from '../errors.ts'
import { JsRuntime } from './base.ts'
import { EVALUATOR, type Evaluator } from '../mixin.ts'
import type { EvalResult, EvalValue, RunArgs, RunResult, RuntimeOptions } from '../types.ts'
import { createMirageBridge, type MirageBridge } from '../python/mirage_bridge.ts'
import type { BridgeDispatchFn } from '../types.ts'
import { QUICKJS_RUNTIME } from './interface.ts'
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

// One-shot evals (the policy engine, console evals) are bounded by the
// VM interrupt because a busy loop blocks the host timer (matches the
// policy evaluation timeout in decide.ts).
const EVAL_INTERRUPT_SECONDS = 10

// Assembles the std/console/scriptArgs surface from injected primitives.
// Kept identical to the quickjs-ng `--std` globals the Python runtime
// exposes, so a script runs the same on both (pinned against the real
// engine): only `console.log` exists (no .error/.warn), `print` is a
// global, both ToString their args (`[object Object]`, not JSON) and
// append a newline, while `std.out.puts`/`std.err.puts` write raw and
// `printf` C-formats (flags -+0 #, star or digit width/precision,
// diufFeEgGxXocs conversions) returning the characters written; an
// unknown conversion throws TypeError like the real engine.
// `std.open`/`os.readdir` are added afterward by MIRAGE_FS_BOOTSTRAP
// when a workspace bridge is wired.
const BOOTSTRAP = `
const __join = (a) => a.map(String).join(' ');
const __pad = (s, flags, width) => {
  if (s.length >= width) return s;
  if (flags.includes('-')) return s + ' '.repeat(width - s.length);
  const fill = flags.includes('0') ? '0' : ' ';
  if (fill === '0' && (s[0] === '-' || s[0] === '+'))
    return s[0] + '0'.repeat(width - s.length) + s.slice(1);
  return fill.repeat(width - s.length) + s;
};
const __exp2 = (s) => s.replace(/e([+-])(\\d)$/, (m, sg, d) => 'e' + sg + '0' + d);
const __sign = (s, flags) => {
  if (s[0] === '-') return s;
  if (flags.includes('+')) return '+' + s;
  if (flags.includes(' ')) return ' ' + s;
  return s;
};
const __padDigits = (s, prec) => {
  if (prec === undefined) return s;
  const neg = s[0] === '-';
  const digits = neg ? s.slice(1) : s;
  return (neg ? '-' : '') + digits.padStart(prec, '0');
};
const __conv1 = (conv, flags, prec, arg) => {
  const n = Number(arg);
  if (conv === 'd' || conv === 'i') return __sign(__padDigits(String(Math.trunc(n)), prec), flags);
  if (conv === 'u') return __padDigits(String(Math.trunc(n) >>> 0), prec);
  if (conv === 'f' || conv === 'F') return __sign(n.toFixed(prec === undefined ? 6 : prec), flags);
  if (conv === 'e' || conv === 'E') {
    const s = __sign(__exp2(n.toExponential(prec === undefined ? 6 : prec)), flags);
    return conv === 'E' ? s.toUpperCase() : s;
  }
  if (conv === 'g' || conv === 'G') {
    let s = n.toPrecision(prec === undefined || prec === 0 ? 6 : prec);
    if (s.includes('e')) s = __exp2(s.replace(/\\.?0+e/, 'e'));
    else if (s.includes('.')) s = s.replace(/\\.?0+$/, '');
    s = __sign(s, flags);
    return conv === 'G' ? s.toUpperCase() : s;
  }
  if (conv === 'x' || conv === 'X') {
    let s = (Math.trunc(n) >>> 0).toString(16);
    if (flags.includes('#') && n !== 0) s = '0x' + s;
    if (conv === 'X') s = s.toUpperCase();
    return s;
  }
  if (conv === 'o') {
    let s = (Math.trunc(n) >>> 0).toString(8);
    if (flags.includes('#') && s[0] !== '0') s = '0' + s;
    return s;
  }
  if (conv === 'c') return typeof arg === 'number' ? String.fromCharCode(arg) : String(arg)[0] || '';
  return prec === undefined ? String(arg) : String(arg).slice(0, prec);
};
const __sprintf = (fmtIn, args) => {
  const fmt = String(fmtIn);
  let out = '';
  let ai = 0;
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] !== '%') { out += fmt[i]; i++; continue; }
    i++;
    if (fmt[i] === '%') { out += '%'; i++; continue; }
    let flags = '';
    while ('-+0 #'.includes(fmt[i])) { flags += fmt[i]; i++; }
    let width = 0;
    if (fmt[i] === '*') { width = Math.trunc(Number(args[ai++])); i++; }
    else while (fmt[i] >= '0' && fmt[i] <= '9') { width = width * 10 + (fmt.charCodeAt(i) - 48); i++; }
    let prec = undefined;
    if (fmt[i] === '.') {
      i++; prec = 0;
      if (fmt[i] === '*') { prec = Math.trunc(Number(args[ai++])); i++; }
      else while (fmt[i] >= '0' && fmt[i] <= '9') { prec = prec * 10 + (fmt.charCodeAt(i) - 48); i++; }
    }
    while ('hlLjzt'.includes(fmt[i])) i++;
    const conv = fmt[i]; i++;
    if (conv === undefined || !'diufFeEgGxXocs'.includes(conv))
      throw new TypeError('invalid conversion specifier in format string');
    out += __pad(__conv1(conv, flags, prec, args[ai++]), flags, width);
  }
  return out;
};
globalThis.console = { log: (...a) => __mirage_log(__join(a) + '\\n') };
globalThis.print = (...a) => __mirage_log(__join(a) + '\\n');
globalThis.std = {
  in: { readAsString: () => __mirage_stdin },
  out: {
    puts: (s) => __mirage_log(String(s)),
    printf: (fmt, ...a) => { const s = __sprintf(fmt, a); __mirage_log(s); return s.length; },
  },
  err: {
    puts: (s) => __mirage_error(String(s)),
    printf: (fmt, ...a) => { const s = __sprintf(fmt, a); __mirage_error(s); return s.length; },
  },
  exit: (n) => { __mirage_setExit(n | 0); throw new Error('__mirage_exit'); },
  getenv: (k) => __mirage_env[k],
};
`

// quickjs-emscripten bundles its own wasm, so the `home` config key
// (for parity with the Python quickjs runtime, which locates
// qjs-wasi.wasm) has nothing to locate here and is ignored.
const QUICKJS_CONFIG_KEYS: readonly string[] = ['home']

// The asyncify variant is used so `std.open`/`os.readdir` can suspend
// the guest while a workspace-mount read or write awaits the dispatch,
// matching the Python runtime's live file I/O.
export class QuickJsRuntime extends JsRuntime implements Evaluator {
  readonly name = QUICKJS_RUNTIME
  readonly [EVALUATOR] = true as const
  static readonly commands: readonly string[] = ['node', 'js'] as const
  private newAsyncModule: NewAsyncModule | null = null
  private workspaceBridge: BridgeDispatchFn | null = null
  private listMounts: () => string[] = () => []

  constructor(options: RuntimeOptions = {}) {
    super(options, QuickJsRuntime.commands, QUICKJS_CONFIG_KEYS)
  }

  override attach(dispatch: BridgeDispatchFn, listMounts: () => string[]): void {
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
    // The guest executes on this event loop, so a busy loop blocks the
    // limit timer itself: the VM's interrupt hook is the only thing
    // that can still fire (python's epoch interruption on a thread).
    const timedOut = this.installInterrupt(runtime, args.signal, args.timeoutSeconds)
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
      runtime.dispose()
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
    if (opts.session !== undefined) {
      throw new EvalError(
        'the quickjs evaluator is one-shot only: each eval is a fresh ' +
          'engine, so console sessions are unsupported',
      )
    }
    const newAsyncModule = await this.loadModule()
    const QuickJS = await newAsyncModule()
    const runtime: QuickJSAsyncRuntime = QuickJS.newRuntime()
    runtime.setMemoryLimit(MEMORY_LIMIT)
    runtime.setMaxStackSize(STACK_SIZE)
    const ctx = runtime.newContext()
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
      // content (the python evaluator gets this via run()'s GuestFs).
      const bridge: MirageBridge | null =
        this.workspaceBridge !== null
          ? createMirageBridge(this.workspaceBridge, this.listMounts)
          : null
      installMirageFs(ctx, bridge)
      const boot = ctx.evalCode(BOOTSTRAP + MIRAGE_FS_BOOTSTRAP, 'mirage:bootstrap')
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
      runtime.dispose()
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
