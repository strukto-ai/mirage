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
import { PythonRuntime } from './base.ts'
import { EvalError } from '../errors.ts'
import { EVALUATOR, type Evaluator } from '../mixin.ts'
import type {
  EvalResult,
  EvalStatus,
  EvalValue,
  RunArgs,
  RunResult,
  RuntimeOptions,
} from '../types.ts'
import { createPyodideInterrupter, type PyodideInterrupter } from './interrupt.ts'
import { loadPyodideRuntime, type PyodideInterface } from './loader.ts'
import { createMirageBridge, preloadInto, type MirageBridge } from './mirage_bridge.ts'
import type { BridgeDispatchFn } from '../types.ts'
import { MIRAGE_FS_SHIM_PY } from './mirage_fs_shim.ts'
import { PYTHON_EVAL_WRAPPER, PYTHON_REPL_WRAPPER, PYTHON_WRAPPER } from './wrapper.ts'
import { PYODIDE_RUNTIME } from './interface.ts'

function bridgeBytes(value: Uint8Array | ArrayLike<number>): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

function bridgeStderr(value: Uint8Array | ArrayLike<number>): Uint8Array | null {
  const bytes = bridgeBytes(value)
  return bytes.length > 0 ? bytes : null
}

function appendStderrLines(stderr: Uint8Array | null, lines: string[]): Uint8Array | null {
  if (lines.length === 0) return stderr
  const extra = new TextEncoder().encode(lines.map((line) => line + '\n').join(''))
  if (stderr === null) return extra
  const out = new Uint8Array(stderr.length + extra.length)
  out.set(stderr)
  out.set(extra, stderr.length)
  return out
}

// The eval wrapper ships python bytes as {'__mirage_bytes__': <b64>}
// (bytes are valid EvalValues but not JSON); this reviver restores
// them to Uint8Array while everything else parses as plain JSON.
const EVAL_BYTES_TAG = '__mirage_bytes__'

function reviveEvalValue(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  const tagged = record[EVAL_BYTES_TAG]
  if (typeof tagged !== 'string' || Object.keys(record).length !== 1) return value
  const binary = atob(tagged)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function runtimeEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  if (proc?.env === undefined) return env
  for (const [k, v] of Object.entries(proc.env)) {
    if (typeof v === 'string') env[k] = v
  }
  return env
}

/**
 * Rewrite top-level imports of denied packages so Pyodide's
 * `loadPackagesFromImports` skips fetching them. The rewritten code is only
 * fed to the auto-loader's import scanner — user code still runs unchanged,
 * so the actual `import X` will hit any meta_path blocker installed in the
 * Python bootstrap.
 *
 * Recognises:
 *   - `import X`, `import X.Y`, `import X as alias`
 *   - `from X import …`, `from X.Y import …`
 * The match is line-scoped (`/m`) so multi-import lines like
 * `import X, Y` are blanked out as a single statement.
 */
export function stripDeniedImports(code: string, denyPackages: ReadonlySet<string>): string {
  if (denyPackages.size === 0) return code
  return code.replace(
    /^[ \t]*(?:from|import)\s+([\w][\w.]*)[^\n]*/gm,
    (match, mod: string): string => {
      const top = mod.split('.')[0] ?? ''
      if (!denyPackages.has(top)) return match
      return match.replace(mod, 'os')
    },
  )
}

/** The pyodide runtime's implementation knobs (its `config` block). */
export interface PyodideConfig {
  autoLoadFromImports?: boolean
  bootstrapCode?: string
  denyPackages?: readonly string[]
  // Where the pyodide distribution loads from; falls back to
  // MIRAGE_PYODIDE_HOME, then the installed package in Node or the
  // pinned CDN in the browser. Override for self-hosted assets.
  home?: string
}

const PYODIDE_CONFIG_KEYS: readonly string[] = [
  'autoLoadFromImports',
  'bootstrapCode',
  'denyPackages',
  'home',
]

// One-shot eval is bounded like quickjs's: nothing above the runtime
// can stop a hung guest on this thread, so the runtime owns its own
// interrupt. Console (repl) sessions stay unbounded, matching python.
const EVAL_INTERRUPT_SECONDS = 10

export class PyodideRuntime extends PythonRuntime implements Evaluator {
  readonly name = PYODIDE_RUNTIME
  readonly [EVALUATOR] = true as const
  static readonly commands: readonly string[] = ['python3', 'python'] as const
  private pyodide: PyodideInterface | null = null
  private initPromise: Promise<PyodideInterface> | null = null
  private bootstrapPromise: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly autoLoadFromImports: boolean
  private readonly bootstrapCode: string | null
  private workspaceBridge: BridgeDispatchFn | null = null
  private readonly denyPackages: ReadonlySet<string>
  private listMounts: () => string[] = () => []
  private readonly home: string | null
  private bridge: MirageBridge | null = null
  private readonly preloadedPrefixes = new Set<string>()
  // The guest executes on this event loop, so only the watchdog-backed
  // interrupt buffer can stop a busy loop (see interrupt.ts); null
  // where SharedArrayBuffer/workers are unavailable (runs unbounded).
  private interrupter: PyodideInterrupter | null = null
  private interrupterTried = false

  constructor(options: RuntimeOptions<PyodideConfig> = {}) {
    super(options, PyodideRuntime.commands, PYODIDE_CONFIG_KEYS)
    const config = this.config as PyodideConfig
    this.autoLoadFromImports = config.autoLoadFromImports ?? true
    this.bootstrapCode = config.bootstrapCode ?? null
    this.denyPackages = new Set(config.denyPackages ?? [])
    this.home = config.home ?? null
  }

  override attach(dispatch: BridgeDispatchFn, listMounts: () => string[]): void {
    if (this.workspaceBridge === null) {
      this.workspaceBridge = dispatch
      this.listMounts = listMounts
    }
  }

  async run(args: RunArgs): Promise<RunResult> {
    const task = (): Promise<RunResult> => this.runOne(args)
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  /**
   * Evaluate code; the last expression is the value. One-shot mode
   * runs on the eval wrapper (value crosses the WASM boundary as
   * JSON); a session id routes through the console wrapper (globals
   * persist per id, value is streamed output only). Console failures
   * come back as transcript results; one-shot failures reject with
   * EvalError.
   */
  async eval(
    code: string,
    opts: { inputs?: Record<string, EvalValue>; session?: string } = {},
  ): Promise<EvalResult> {
    const task = (): Promise<EvalResult> => this.evalOne(code, opts)
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async evalOne(
    code: string,
    opts: { inputs?: Record<string, EvalValue>; session?: string },
  ): Promise<EvalResult> {
    if (opts.session !== undefined) {
      const repl = await this.runOneRepl(code, opts.session, opts.inputs ?? {})
      return { value: null, ...repl }
    }
    const pyodide = await this.ensureLoaded()
    await this.loadImports(pyodide, code)
    const inputsPy = pyodide.toPy(opts.inputs ?? {})
    pyodide.globals.set('_user_code', code)
    pyodide.globals.set('_eval_inputs', inputsPy)
    const armed = this.interrupter !== null ? this.interrupter.arm(EVAL_INTERRUPT_SECONDS) : null
    try {
      await pyodide.runPythonAsync(PYTHON_EVAL_WRAPPER)
      if (armed?.disarm() === 'deadline') {
        throw new EvalError(`pyodide eval timed out after ${String(EVAL_INTERRUPT_SECONDS)}s`)
      }
      const flushFailures = await this.drainDirty(pyodide)
      const resultProxy = pyodide.globals.get('_eval_result') as
        | {
            toJs?: (opts?: Record<string, unknown>) => unknown
            destroy?: () => void
          }
        | null
        | undefined
      const arr = resultProxy?.toJs?.({ create_proxies: false }) as
        | [string, Uint8Array, Uint8Array, boolean, boolean]
        | undefined
      resultProxy?.destroy?.()
      if (arr === undefined) {
        throw new EvalError('pyodide returned no eval result')
      }
      const [valueJson, out, errBytes, ok, syntax] = arr
      if (!ok) {
        for (const failure of flushFailures) console.warn(failure)
        const detail = new TextDecoder().decode(bridgeBytes(errBytes)).trim()
        throw new EvalError(detail !== '' ? detail : 'evaluation failed', { syntax })
      }
      return {
        value: JSON.parse(valueJson, reviveEvalValue) as EvalValue,
        stdout: bridgeBytes(out),
        stderr: appendStderrLines(bridgeStderr(errBytes), flushFailures),
        exitCode: flushFailures.length > 0 ? 1 : 0,
        status: 'complete',
      }
    } catch (err) {
      const deadline = armed?.disarm() === 'deadline'
      for (const failure of await this.drainDirty(pyodide)) console.warn(failure)
      if (deadline) {
        throw new EvalError(`pyodide eval timed out after ${String(EVAL_INTERRUPT_SECONDS)}s`, {
          cause: err,
        })
      }
      throw err
    } finally {
      armed?.disarm()
      pyodide.globals.delete?.('_user_code')
      pyodide.globals.delete?.('_eval_inputs')
      pyodide.globals.delete?.('_eval_result')
      if (inputsPy !== null && typeof inputsPy === 'object' && 'destroy' in inputsPy) {
        try {
          ;(inputsPy as { destroy: () => void }).destroy()
        } catch {
          // destroy is best-effort; ignore double-destroy errors
        }
      }
    }
  }

  override async close(): Promise<void> {
    try {
      await this.queue
    } catch {
      // queue failures already surfaced to individual callers; safe to swallow here
    }
    this.pyodide = null
    this.initPromise = null
    this.bridge = null
    this.preloadedPrefixes.clear()
    this.interrupter?.close()
    this.interrupter = null
    this.interrupterTried = false
  }

  private async wireInterruptIfNeeded(pyodide: PyodideInterface): Promise<void> {
    if (this.interrupterTried || pyodide.setInterruptBuffer === undefined) return
    this.interrupterTried = true
    this.interrupter = await createPyodideInterrupter()
    if (this.interrupter !== null) pyodide.setInterruptBuffer(this.interrupter.view)
  }

  private async ensureLoaded(): Promise<PyodideInterface> {
    if (this.pyodide !== null) {
      if (this.bootstrapPromise !== null) await this.bootstrapPromise
      await this.wireBridgeIfNeeded(this.pyodide)
      await this.preloadNewPrefixes(this.pyodide)
      await this.wireInterruptIfNeeded(this.pyodide)
      return this.pyodide
    }
    this.initPromise ??= loadPyodideRuntime(this.home ?? undefined)
    this.pyodide = await this.initPromise
    if (this.bootstrapCode !== null) {
      const code = this.bootstrapCode
      const py = this.pyodide
      this.bootstrapPromise = (async () => {
        if (py.loadPackagesFromImports !== undefined) {
          try {
            await py.loadPackagesFromImports(code, { messageCallback: () => undefined })
          } catch {
            // best-effort
          }
        }
        await py.runPythonAsync(code)
      })()
      await this.bootstrapPromise
    }
    await this.wireBridgeIfNeeded(this.pyodide)
    await this.preloadNewPrefixes(this.pyodide)
    await this.wireInterruptIfNeeded(this.pyodide)
    return this.pyodide
  }

  private async wireBridgeIfNeeded(pyodide: PyodideInterface): Promise<void> {
    if (this.workspaceBridge === null || this.bridge !== null) return
    const bridge = createMirageBridge(this.workspaceBridge, this.listMounts)
    pyodide.registerJsModule('_mirage_bridge', bridge)
    await pyodide.runPythonAsync(MIRAGE_FS_SHIM_PY)
    this.bridge = bridge
  }

  /**
   * Hydrate MEMFS for mount prefixes not yet preloaded, before every run.
   * This is the host-side half of read visibility: a mount added after
   * boot gets its tree here, where awaiting the bridge is free, instead
   * of relying on the shim's lazy backfill, whose run_sync needs JSPI.
   * Content changes under an already-preloaded prefix still ride the
   * lazy path (a full re-list per run would be one API sweep per mount).
   */
  private async preloadNewPrefixes(pyodide: PyodideInterface): Promise<void> {
    if (this.bridge === null) return
    for (const prefix of this.bridge.prefixes()) {
      if (this.preloadedPrefixes.has(prefix)) continue
      // Record only after success: preloadInto's one throw path is the
      // top-level LIST (per-entry failures warn and continue), so a
      // transient failure surfaces loudly and retries on the next run
      // instead of poisoning the prefix for the runtime's lifetime.
      await preloadInto(pyodide.FS, this.bridge, prefix)
      this.preloadedPrefixes.add(prefix)
    }
  }

  /**
   * Flush every path the shim marked dirty during the run. The guest
   * cannot await the bridge from its sync WASM frames without JSPI, so
   * close() only marks; MEMFS holds the final bytes, and one WRITE per
   * path covers however many times the script reopened it. Returns one
   * message per failed flush for the caller's stderr.
   */
  private async drainDirty(pyodide: PyodideInterface): Promise<string[]> {
    if (this.bridge === null) return []
    const failures: string[] = []
    for (const path of this.bridge.takeDirty()) {
      let bytes: Uint8Array
      try {
        bytes = pyodide.FS.readFile(path) as Uint8Array
      } catch {
        // closed then unlinked locally; unlink does not propagate, so
        // the mount keeps its previous content
        console.warn(`mirage flush: ${path} marked dirty but missing from MEMFS, skipped`)
        continue
      }
      try {
        await this.bridge.flush(path, bytes)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        failures.push(`python3: failed to flush ${path} to mount: ${detail}`)
      }
    }
    return failures
  }

  private async loadImports(pyodide: PyodideInterface, code: string): Promise<void> {
    if (!this.autoLoadFromImports) return
    if (pyodide.loadPackagesFromImports === undefined) return
    const filtered = stripDeniedImports(code, this.denyPackages)
    try {
      await pyodide.loadPackagesFromImports(filtered, { messageCallback: () => undefined })
    } catch {
      // best-effort: missing/unknown packages will surface as ImportError in user code
    }
  }

  private async runOne(args: RunArgs): Promise<RunResult> {
    const pyodide = await this.ensureLoaded()
    await this.loadImports(pyodide, args.code)
    const mergedEnv = { ...runtimeEnv(), ...args.env }
    // sys.argv[0] is the program's own name when the caller has one (a
    // CLI install's head word), else CPython's own -c spelling.
    const argv = [args.prog ?? '-c', ...args.args]
    const stdinBytes = args.stdin ?? new Uint8Array()

    const mergedEnvPy = pyodide.toPy(mergedEnv)
    const argvPy = pyodide.toPy(argv)
    const userGlobalsPy = pyodide.toPy({})

    pyodide.globals.set('_user_code', args.code)
    pyodide.globals.set('_argv', argvPy)
    pyodide.globals.set('_merged_env', mergedEnvPy)
    pyodide.globals.set('_stdin_bytes', stdinBytes)
    pyodide.globals.set('_user_globals', userGlobalsPy)

    // Deadline trip -> exit 124 via CommandTimeoutError; a kill signal
    // raises KeyboardInterrupt in the guest, whose wrapper-reported
    // exit code (1) stands, like the local runtime's killed child.
    const armed =
      this.interrupter !== null
        ? this.interrupter.arm(args.timeoutSeconds ?? null, args.signal)
        : null
    try {
      await pyodide.runPythonAsync(PYTHON_WRAPPER)
      if (armed?.disarm() === 'deadline' && args.timeoutSeconds !== undefined) {
        throw new CommandTimeoutError(this.name, args.timeoutSeconds)
      }
      const flushFailures = await this.drainDirty(pyodide)
      const resultProxy = pyodide.globals.get('_result') as
        | {
            toJs?: (opts?: Record<string, unknown>) => unknown
            destroy?: () => void
          }
        | null
        | undefined
      const arr = resultProxy?.toJs?.({ create_proxies: false }) as
        | [Uint8Array, Uint8Array, number]
        | undefined
      resultProxy?.destroy?.()
      if (arr === undefined) {
        return {
          stdout: new Uint8Array(),
          stderr: appendStderrLines(
            new TextEncoder().encode('python3: runtime returned no result\n'),
            flushFailures,
          ),
          exitCode: 1,
        }
      }
      return {
        stdout: bridgeBytes(arr[0]),
        stderr: appendStderrLines(bridgeStderr(arr[1]), flushFailures),
        exitCode: flushFailures.length > 0 && arr[2] === 0 ? 1 : arr[2],
      }
    } catch (err) {
      // The interrupt can also fire between wrapper statements, where
      // KeyboardInterrupt escapes as a rejection instead of a result.
      // Files closed before the failure are complete in MEMFS, so their
      // marks still flush; failures can only be warned here.
      const deadline = armed?.disarm() === 'deadline'
      for (const failure of await this.drainDirty(pyodide)) console.warn(failure)
      if (deadline && args.timeoutSeconds !== undefined) {
        throw new CommandTimeoutError(this.name, args.timeoutSeconds)
      }
      throw err
    } finally {
      armed?.disarm()
      pyodide.globals.delete?.('_user_code')
      pyodide.globals.delete?.('_argv')
      pyodide.globals.delete?.('_merged_env')
      pyodide.globals.delete?.('_stdin_bytes')
      pyodide.globals.delete?.('_user_globals')
      pyodide.globals.delete?.('_result')
      const maybeDestroy = (obj: unknown): void => {
        if (obj !== null && typeof obj === 'object' && 'destroy' in obj) {
          try {
            ;(obj as { destroy: () => void }).destroy()
          } catch {
            // destroy is best-effort; ignore double-destroy errors
          }
        }
      }
      maybeDestroy(mergedEnvPy)
      maybeDestroy(argvPy)
      maybeDestroy(userGlobalsPy)
    }
  }

  private async runOneRepl(
    code: string,
    sessionId: string,
    inputs: Record<string, EvalValue> = {},
  ): Promise<Omit<EvalResult, 'value'>> {
    const pyodide = await this.ensureLoaded()
    await this.loadImports(pyodide, code)

    pyodide.globals.set('_user_code', code)
    pyodide.globals.set('_repl_session_id', sessionId)
    pyodide.globals.set('_repl_inputs', pyodide.toPy(inputs))

    try {
      await pyodide.runPythonAsync(PYTHON_REPL_WRAPPER)
      const flushFailures = await this.drainDirty(pyodide)
      const resultProxy = pyodide.globals.get('_repl_result') as
        | {
            toJs?: (opts?: Record<string, unknown>) => unknown
            destroy?: () => void
          }
        | null
        | undefined
      const arr = resultProxy?.toJs?.({ create_proxies: false }) as
        | [Uint8Array, Uint8Array, number, EvalStatus]
        | undefined
      resultProxy?.destroy?.()
      if (arr === undefined) {
        return {
          stdout: new Uint8Array(),
          stderr: appendStderrLines(
            new TextEncoder().encode('python3: repl returned no result\n'),
            flushFailures,
          ),
          exitCode: 1,
          status: 'complete',
        }
      }
      return {
        stdout: bridgeBytes(arr[0]),
        stderr: appendStderrLines(bridgeStderr(arr[1]), flushFailures),
        exitCode: flushFailures.length > 0 && arr[2] === 0 ? 1 : arr[2],
        status: arr[3],
      }
    } finally {
      pyodide.globals.delete?.('_user_code')
      pyodide.globals.delete?.('_repl_session_id')
      pyodide.globals.delete?.('_repl_inputs')
      pyodide.globals.delete?.('_repl_result')
    }
  }
}
