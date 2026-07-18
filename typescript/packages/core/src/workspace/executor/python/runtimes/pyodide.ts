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

import type { RunArgs, RunResult } from '../../runtime.ts'
import { loadPyodideRuntime, type PyodideInterface } from '../loader.ts'
import {
  createMirageBridge,
  preloadInto,
  type BridgeDispatchFn,
  type MirageBridge,
} from '../mirage_bridge.ts'
import { MIRAGE_FS_SHIM_PY } from '../mirage_fs_shim.ts'
import { PYTHON_REPL_WRAPPER, PYTHON_WRAPPER } from '../wrapper.ts'
import { PYODIDE_RUNTIME, type PythonRuntime, type PythonRuntimeOptions } from './interface.ts'
import type { PythonReplRunArgs, PythonReplRunResult, ReplStatus } from '../types.ts'

function bridgeBytes(value: Uint8Array | ArrayLike<number>): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

function bridgeStderr(value: Uint8Array | ArrayLike<number>): Uint8Array | null {
  const bytes = bridgeBytes(value)
  return bytes.length > 0 ? bytes : null
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

export interface PyodideRuntimeOptions extends PythonRuntimeOptions {
  autoLoadFromImports?: boolean
  bootstrapCode?: string
  denyPackages?: readonly string[]
  // Where the pyodide distribution loads from (the yaml
  // `runtime: pyodide: home:` entry ends up here); falls back to
  // MIRAGE_PYODIDE_HOME, then the installed package in Node or the
  // pinned CDN in the browser. Override for self-hosted assets.
  home?: string
}

export class PyodideRuntime implements PythonRuntime {
  readonly name = PYODIDE_RUNTIME
  static readonly commands: readonly string[] = ['python3', 'python'] as const
  readonly captures = PyodideRuntime.commands
  private pyodide: PyodideInterface | null = null
  private initPromise: Promise<PyodideInterface> | null = null
  private bootstrapPromise: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly autoLoadFromImports: boolean
  private readonly bootstrapCode: string | null
  private workspaceBridge: BridgeDispatchFn | null
  private readonly denyPackages: ReadonlySet<string>
  private listMounts: () => string[]
  private readonly home: string | null
  private bridge: MirageBridge | null = null

  constructor(options: PyodideRuntimeOptions = {}) {
    this.autoLoadFromImports = options.autoLoadFromImports ?? true
    this.bootstrapCode = options.bootstrapCode ?? null
    this.workspaceBridge = options.workspaceBridge ?? null
    this.denyPackages = new Set(options.denyPackages ?? [])
    this.listMounts = options.listMounts ?? ((): string[] => [])
    this.home = options.home ?? null
  }

  attach(dispatch: BridgeDispatchFn, listMounts: () => string[]): void {
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

  async runRepl(args: PythonReplRunArgs): Promise<PythonReplRunResult> {
    const task = (): Promise<PythonReplRunResult> => this.runOneRepl(args)
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  async close(): Promise<void> {
    try {
      await this.queue
    } catch {
      // queue failures already surfaced to individual callers; safe to swallow here
    }
    this.pyodide = null
    this.initPromise = null
    this.bridge = null
  }

  private async ensureLoaded(): Promise<PyodideInterface> {
    if (this.pyodide !== null) {
      if (this.bootstrapPromise !== null) await this.bootstrapPromise
      await this.wireBridgeIfNeeded(this.pyodide)
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
    return this.pyodide
  }

  private async wireBridgeIfNeeded(pyodide: PyodideInterface): Promise<void> {
    if (this.workspaceBridge === null || this.bridge !== null) return
    const bridge = createMirageBridge(this.workspaceBridge, this.listMounts)
    pyodide.registerJsModule('_mirage_bridge', bridge)
    await pyodide.runPythonAsync(MIRAGE_FS_SHIM_PY)
    this.bridge = bridge
    for (const prefix of bridge.prefixes()) {
      await preloadInto(pyodide.FS, bridge, prefix)
    }
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
    const argv = ['-c', ...args.args]
    const stdinBytes = args.stdin ?? new Uint8Array()

    const mergedEnvPy = pyodide.toPy(mergedEnv)
    const argvPy = pyodide.toPy(argv)
    const userGlobalsPy = pyodide.toPy({})

    pyodide.globals.set('_user_code', args.code)
    pyodide.globals.set('_argv', argvPy)
    pyodide.globals.set('_merged_env', mergedEnvPy)
    pyodide.globals.set('_stdin_bytes', stdinBytes)
    pyodide.globals.set('_user_globals', userGlobalsPy)

    try {
      await pyodide.runPythonAsync(PYTHON_WRAPPER)
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
          stderr: new TextEncoder().encode('python3: runtime returned no result\n'),
          exitCode: 1,
        }
      }
      return {
        stdout: bridgeBytes(arr[0]),
        stderr: bridgeStderr(arr[1]),
        exitCode: arr[2],
      }
    } finally {
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

  private async runOneRepl(args: PythonReplRunArgs): Promise<PythonReplRunResult> {
    const pyodide = await this.ensureLoaded()
    await this.loadImports(pyodide, args.code)

    pyodide.globals.set('_user_code', args.code)
    pyodide.globals.set('_repl_session_id', args.sessionId)

    try {
      await pyodide.runPythonAsync(PYTHON_REPL_WRAPPER)
      const resultProxy = pyodide.globals.get('_repl_result') as
        | {
            toJs?: (opts?: Record<string, unknown>) => unknown
            destroy?: () => void
          }
        | null
        | undefined
      const arr = resultProxy?.toJs?.({ create_proxies: false }) as
        | [Uint8Array, Uint8Array, number, ReplStatus]
        | undefined
      resultProxy?.destroy?.()
      if (arr === undefined) {
        return {
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode('python3: repl returned no result\n'),
          exitCode: 1,
          status: 'complete',
        }
      }
      return {
        stdout: bridgeBytes(arr[0]),
        stderr: bridgeStderr(arr[1]),
        exitCode: arr[2],
        status: arr[3],
      }
    } finally {
      pyodide.globals.delete?.('_user_code')
      pyodide.globals.delete?.('_repl_session_id')
      pyodide.globals.delete?.('_repl_result')
    }
  }
}
