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
import type { BridgeDispatchFn } from '../mirage_bridge.ts'
import { MONTY_RUNTIME, type PythonRuntime, type PythonRuntimeOptions } from './interface.ts'
import type { PythonReplRunArgs, PythonReplRunResult } from '../types.ts'

export class MontyUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MontyUnavailableError'
  }
}

// Structural views of @pydantic/monty so its types never leak into our
// public .d.ts (the package is an optional peer dependency).
interface MontySessionLike {
  feedRun(code: string, options?: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

interface MontyPoolLike {
  checkout(options?: Record<string, unknown>): Promise<MontySessionLike>
  close(): Promise<void>
}

interface MontyModuleLike {
  Monty: { create(options?: Record<string, unknown>): Promise<MontyPoolLike> }
  NOT_HANDLED: symbol
  MontySyntaxError: new (...args: never[]) => Error
  MontyRuntimeError: new (...args: never[]) => Error
}

interface MontyDisplayableError extends Error {
  display?: (format?: string) => string
}

interface MirageEntryLike {
  path: string
  isDir: boolean
}

function displayError(err: unknown): string {
  const e = err as MontyDisplayableError
  if (typeof e.display === 'function') return e.display('traceback')
  return e instanceof Error ? e.message : String(err)
}

export type MontyRuntimeOptions = PythonRuntimeOptions

/**
 * Run Python code on the Monty sandboxed interpreter (`@pydantic/monty`).
 *
 * Code executes in a crash-isolated Monty worker: no host filesystem,
 * environment, or network access. `pathlib` I/O and `os.getenv` are
 * serviced through the workspace bridge, so the code sees the workspace
 * mounts and nothing else. Command-line arguments are exposed as the
 * `argv` global (`argv[0]` is the script name). Monty implements a
 * Python subset; host-only features (`sys.stdin`, `sys.argv`,
 * third-party imports) are unavailable, and the builtin `open()` is not
 * bridgeable yet (the JS binding cannot return a file handle from an
 * `os` callback) — use `pathlib` for file I/O, or the pyodide runtime.
 */
export class MontyRuntime implements PythonRuntime {
  readonly name = MONTY_RUNTIME
  static readonly commands: readonly string[] = ['python3', 'python'] as const
  readonly captures = MontyRuntime.commands
  private workspaceBridge: BridgeDispatchFn | null
  private listMounts: () => string[]
  private module: MontyModuleLike | null = null
  private pool: MontyPoolLike | null = null
  private poolPromise: Promise<MontyPoolLike> | null = null
  private readonly replSessions = new Map<string, MontySessionLike>()

  constructor(options: MontyRuntimeOptions = {}) {
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
    const pool = await this.ensurePool()
    const session = await pool.checkout()
    try {
      return await this.feedOne(session, args.code, args)
    } finally {
      await session.close()
    }
  }

  async runRepl(args: PythonReplRunArgs): Promise<PythonReplRunResult> {
    const pool = await this.ensurePool()
    let session = this.replSessions.get(args.sessionId)
    if (session === undefined) {
      session = await pool.checkout()
      this.replSessions.set(args.sessionId, session)
    }
    const result = await this.feedOne(session, args.code, {
      code: args.code,
      args: [],
      env: {},
      stdin: null,
    })
    const incomplete =
      result.exitCode !== 0 &&
      result.stderr !== null &&
      new TextDecoder().decode(result.stderr).includes('unexpected EOF while parsing')
    if (incomplete) {
      return {
        stdout: new Uint8Array(),
        stderr: null,
        exitCode: 0,
        status: 'incomplete',
      }
    }
    return { ...result, status: 'complete' }
  }

  async close(): Promise<void> {
    for (const session of this.replSessions.values()) {
      await session.close()
    }
    this.replSessions.clear()
    if (this.pool !== null) {
      await this.pool.close()
      this.pool = null
    }
    this.poolPromise = null
  }

  private async ensurePool(): Promise<MontyPoolLike> {
    if (this.pool !== null) return this.pool
    this.poolPromise ??= this.loadPool()
    this.pool = await this.poolPromise
    return this.pool
  }

  private async loadPool(): Promise<MontyPoolLike> {
    const module = await this.loadModule()
    return module.Monty.create()
  }

  private async loadModule(): Promise<MontyModuleLike> {
    if (this.module !== null) return this.module
    try {
      this.module = (await import('@pydantic/monty')) as unknown as MontyModuleLike
    } catch (err) {
      throw new MontyUnavailableError(
        "monty runtime requires the '@pydantic/monty' package — install it or select the pyodide runtime",
        { cause: err },
      )
    }
    return this.module
  }

  private async feedOne(
    session: MontySessionLike,
    code: string,
    args: RunArgs,
  ): Promise<RunResult> {
    const module = await this.loadModule()
    const out: string[] = []
    const err: string[] = []
    const options: Record<string, unknown> = {
      inputs: { argv: ['main.py', ...args.args] },
      printCallback: (stream: 'stdout' | 'stderr', text: string) => {
        if (stream === 'stderr') err.push(text)
        else out.push(text)
      },
      os: this.buildOsCallback(module, args.env),
    }
    try {
      await session.feedRun(code, options)
    } catch (caught) {
      if (caught instanceof module.MontySyntaxError || caught instanceof module.MontyRuntimeError) {
        err.push(displayError(caught) + '\n')
        return {
          stdout: new TextEncoder().encode(out.join('')),
          stderr: err.length > 0 ? new TextEncoder().encode(err.join('')) : null,
          exitCode: 1,
        }
      }
      throw caught
    }
    return {
      stdout: new TextEncoder().encode(out.join('')),
      stderr: err.length > 0 ? new TextEncoder().encode(err.join('')) : null,
      exitCode: 0,
    }
  }

  private buildOsCallback(
    module: MontyModuleLike,
    env: Record<string, string>,
  ): (name: string, args: unknown[]) => unknown {
    const bridge = this.workspaceBridge
    const notHandled = module.NOT_HANDLED
    return (name: string, args: unknown[]): unknown => {
      if (name === 'os.getenv') {
        const key = String(args[0])
        if (key in env) return env[key]
        return args.length > 1 ? args[1] : null
      }
      if (bridge === null) return notHandled
      const path = pathArg(args[0])
      if (path === null) return notHandled
      if (!this.underWorkspaceMount(path)) return notHandled
      switch (name) {
        case 'Path.read_bytes':
          return readBytes(bridge, path)
        case 'Path.read_text':
          return readBytes(bridge, path).then((b) => new TextDecoder().decode(b))
        case 'Path.write_bytes':
        case 'Path.write_text':
          return writeBack(bridge, path, args[1])
        case 'Path.iterdir':
          return listEntries(bridge, path).then((entries) => entries.map((e) => e.path))
        case 'Path.is_dir':
          return listEntries(bridge, path).then(
            () => true,
            () => false,
          )
        case 'Path.is_file':
          return entryFor(bridge, path).then(
            (e) => e !== null && !e.isDir,
            () => false,
          )
        case 'Path.exists':
          return entryFor(bridge, path).then(
            (e) => e !== null,
            () =>
              listEntries(bridge, path).then(
                () => true,
                () => false,
              ),
          )
        default:
          return notHandled
      }
    }
  }

  /**
   * True when `path` may be serviced by the workspace bridge. An empty
   * live view means no scoping: every path routes to the bridge.
   */
  private underWorkspaceMount(path: string): boolean {
    const prefixes = this.listMounts()
    if (prefixes.length === 0) return true
    return prefixes.some((p) => {
      const norm = p.endsWith('/') ? p : p + '/'
      return path.startsWith(norm) || path === norm.slice(0, -1)
    })
  }
}

let routeModulePromise: Promise<MontyModuleLike> | null = null
let routePool: MontyPoolLike | null = null
let routePoolPromise: Promise<MontyPoolLike> | null = null

async function routeModule(): Promise<MontyModuleLike> {
  routeModulePromise ??= import('@pydantic/monty').then(
    (m) => m as unknown as MontyModuleLike,
    (err: unknown) => {
      routeModulePromise = null
      throw new MontyUnavailableError(
        "route scripts run on monty; install '@pydantic/monty' or use a function instead",
        { cause: err },
      )
    },
  )
  return routeModulePromise
}

/**
 * Evaluate a route script on monty; the snippet's trailing expression
 * is the verdict. The script sees the ctx payload as the `ctx` global
 * and gets read-only workspace file access through the bridge.
 */
export async function evalMontyValue(
  code: string,
  payload: Record<string, unknown>,
  bridge: BridgeDispatchFn | null,
): Promise<unknown> {
  const module = await routeModule()
  if (routePool === null) {
    routePoolPromise ??= module.Monty.create()
    routePool = await routePoolPromise
  }
  const session = await routePool.checkout()
  try {
    return await session.feedRun(code, {
      inputs: { ctx: payload },
      os: routeOsCallback(module, bridge),
    })
  } catch (caught) {
    if (caught instanceof module.MontySyntaxError) {
      throw new Error('route script syntax error: ' + displayError(caught))
    }
    if (caught instanceof module.MontyRuntimeError) {
      throw new Error('route script failed: ' + displayError(caught))
    }
    throw caught
  } finally {
    await session.close()
  }
}

function routeOsCallback(
  module: MontyModuleLike,
  bridge: BridgeDispatchFn | null,
): (name: string, args: unknown[]) => unknown {
  const notHandled = module.NOT_HANDLED
  return (name: string, args: unknown[]): unknown => {
    if (bridge === null) return notHandled
    const path = pathArg(args[0])
    if (path === null) return notHandled
    switch (name) {
      case 'Path.read_bytes':
        return readBytes(bridge, path)
      case 'Path.read_text':
        return readBytes(bridge, path).then((b) => new TextDecoder().decode(b))
      case 'Path.iterdir':
        return listEntries(bridge, path).then((entries) => entries.map((e) => e.path))
      case 'Path.is_dir':
        return listEntries(bridge, path).then(
          () => true,
          () => false,
        )
      case 'Path.is_file':
        return entryFor(bridge, path).then(
          (e) => e !== null && !e.isDir,
          () => false,
        )
      case 'Path.exists':
        return entryFor(bridge, path).then(
          (e) => e !== null,
          () =>
            listEntries(bridge, path).then(
              () => true,
              () => false,
            ),
        )
      default:
        return notHandled
    }
  }
}

function pathArg(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && 'path' in value) {
    const p = (value as { path: unknown }).path
    return typeof p === 'string' ? p : null
  }
  return null
}

async function readBytes(bridge: BridgeDispatchFn, path: string): Promise<Uint8Array> {
  const data = await bridge('READ', path)
  if (data instanceof Uint8Array) return data
  throw new Error(`monty bridge: READ ${path} expected bytes`)
}

async function writeBack(bridge: BridgeDispatchFn, path: string, data: unknown): Promise<number> {
  const bytes =
    data instanceof Uint8Array
      ? data
      : new TextEncoder().encode(typeof data === 'string' ? data : '')
  await bridge('WRITE', path, bytes)
  return typeof data === 'string' ? data.length : bytes.length
}

async function listEntries(bridge: BridgeDispatchFn, path: string): Promise<MirageEntryLike[]> {
  const prefix = path.endsWith('/') ? path : path + '/'
  const out = await bridge('LIST', prefix)
  if (!Array.isArray(out)) throw new Error(`monty bridge: LIST ${prefix} expected array`)
  return out as MirageEntryLike[]
}

async function entryFor(bridge: BridgeDispatchFn, path: string): Promise<MirageEntryLike | null> {
  const slash = path.lastIndexOf('/')
  const parent = slash <= 0 ? '/' : path.slice(0, slash)
  const entries = await listEntries(bridge, parent)
  return entries.find((e) => e.path === path || e.path === path + '/') ?? null
}
