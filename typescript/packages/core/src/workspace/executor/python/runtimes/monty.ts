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

import { Runtime } from '../../runtime.ts'
import { EvalError } from '../../runtime_errors.ts'
import { EVALUATOR, type Evaluator } from '../../runtime_mixin.ts'
import type {
  EvalResult,
  EvalValue,
  RunArgs,
  RunResult,
  RuntimeOptions,
} from '../../runtime_types.ts'
import type { BridgeDispatchFn } from '../mirage_bridge.ts'
import { MONTY_RUNTIME } from './interface.ts'

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

/**
 * Fold Monty's value shapes into the EvalValue contract: the worker
 * hands python dicts back as Map, but EvalValue promises str-keyed
 * plain objects (what pyodide's JSON transport already yields).
 */
function toEvalValue(value: unknown): EvalValue {
  if (value instanceof Map) {
    const obj: Record<string, EvalValue> = {}
    for (const [key, entry] of value) obj[String(key)] = toEvalValue(entry)
    return obj
  }
  if (Array.isArray(value)) return value.map(toEvalValue)
  return value as EvalValue
}

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
export class MontyRuntime extends Runtime implements Evaluator {
  readonly name = MONTY_RUNTIME
  readonly [EVALUATOR] = true as const
  static readonly commands: readonly string[] = ['python3', 'python'] as const
  private workspaceBridge: BridgeDispatchFn | null = null
  private listMounts: () => string[] = () => []
  private module: MontyModuleLike | null = null
  private pool: MontyPoolLike | null = null
  private poolPromise: Promise<MontyPoolLike> | null = null
  private readonly evalSessions = new Map<string, MontySessionLike>()

  constructor(options: RuntimeOptions = {}) {
    super(options, MontyRuntime.commands, [])
  }

  override attach(dispatch: BridgeDispatchFn, listMounts: () => string[]): void {
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

  /**
   * Evaluate code in-process; the last expression is the value.
   *
   * One-shot mode evaluates on a throwaway pool session; a session id
   * keeps the session (heap and namespace) alive per id, which is the
   * console. Inputs bind as globals via monty's native mechanism, and
   * the code sees workspace files through the same bridge agent code
   * uses. Console failures come back as transcript results (stderr +
   * exitCode 1); one-shot failures reject with EvalError.
   */
  async eval(
    code: string,
    opts: { inputs?: Record<string, EvalValue>; session?: string } = {},
  ): Promise<EvalResult> {
    const pool = await this.ensurePool()
    const module = await this.loadModule()
    let session: MontySessionLike
    if (opts.session !== undefined) {
      let existing = this.evalSessions.get(opts.session)
      if (existing === undefined) {
        existing = await pool.checkout()
        this.evalSessions.set(opts.session, existing)
      }
      session = existing
    } else {
      session = await pool.checkout()
    }
    const out: string[] = []
    const err: string[] = []
    const options: Record<string, unknown> = {
      inputs: { ...(opts.inputs ?? {}) },
      printCallback: (stream: 'stdout' | 'stderr', text: string) => {
        if (stream === 'stderr') err.push(text)
        else out.push(text)
      },
      os: this.buildOsCallback(module, {}),
    }
    const enc = new TextEncoder()
    try {
      const value = toEvalValue(await session.feedRun(code, options))
      return {
        value,
        stdout: enc.encode(out.join('')),
        stderr: err.length > 0 ? enc.encode(err.join('')) : null,
        exitCode: 0,
        status: 'complete',
      }
    } catch (caught) {
      if (caught instanceof module.MontySyntaxError) {
        const trace = displayError(caught)
        // Console continuation, not a broken program: the source
        // merely stopped early (an open block or unclosed suite).
        const incomplete =
          trace.includes('unexpected EOF') || trace.includes('Expected an indented block')
        if (opts.session !== undefined) {
          if (incomplete) {
            return {
              value: null,
              stdout: new Uint8Array(),
              stderr: null,
              exitCode: 0,
              status: 'incomplete',
            }
          }
          return {
            value: null,
            stdout: enc.encode(out.join('')),
            stderr: enc.encode(trace + '\n'),
            exitCode: 1,
            status: 'complete',
          }
        }
        throw new EvalError(trace, { syntax: true, cause: caught })
      }
      if (caught instanceof module.MontyRuntimeError) {
        const trace = displayError(caught)
        if (opts.session !== undefined) {
          return {
            value: null,
            stdout: enc.encode(out.join('')),
            stderr: enc.encode(err.join('') + trace + '\n'),
            exitCode: 1,
            status: 'complete',
          }
        }
        throw new EvalError(trace, { cause: caught })
      }
      throw caught
    } finally {
      if (opts.session === undefined) await session.close()
    }
  }

  override async close(): Promise<void> {
    for (const session of this.evalSessions.values()) {
      await session.close()
    }
    this.evalSessions.clear()
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

function pathArg(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && 'path' in value) {
    const p = (value as { path: unknown }).path
    return typeof p === 'string' ? p : null
  }
  return null
}

// fs error codes -> the python exception the guest should catch, with
// CPython's errno message shape.
const CODE_TO_GUEST_EXC: Record<string, { name: string; errno: number; phrase: string }> = {
  ENOENT: { name: 'FileNotFoundError', errno: 2, phrase: 'No such file or directory' },
  EISDIR: { name: 'IsADirectoryError', errno: 21, phrase: 'Is a directory' },
  ENOTDIR: { name: 'NotADirectoryError', errno: 20, phrase: 'Not a directory' },
  EACCES: { name: 'PermissionError', errno: 13, phrase: 'Permission denied' },
}

/**
 * Re-throw a bridge failure under its python exception name: the monty
 * binding raises `err.name` as the matching guest exception type
 * (PYTHON_EXC_NAMES), so agent code can `except FileNotFoundError`
 * exactly as it does on the python host.
 */
function asGuestError(err: unknown, path: string): unknown {
  const code = (err as { code?: string }).code
  const mapped = code !== undefined ? CODE_TO_GUEST_EXC[code] : undefined
  if (mapped === undefined) return err
  const guest = new Error(`[Errno ${mapped.errno}] ${mapped.phrase}: '${path}'`)
  guest.name = mapped.name
  return guest
}

async function readBytes(bridge: BridgeDispatchFn, path: string): Promise<Uint8Array> {
  let data: unknown
  try {
    data = await bridge('READ', path)
  } catch (caught) {
    throw asGuestError(caught, path)
  }
  if (data instanceof Uint8Array) return data
  throw new Error(`monty bridge: READ ${path} expected bytes`)
}

async function writeBack(bridge: BridgeDispatchFn, path: string, data: unknown): Promise<number> {
  const bytes =
    data instanceof Uint8Array
      ? data
      : new TextEncoder().encode(typeof data === 'string' ? data : '')
  try {
    await bridge('WRITE', path, bytes)
  } catch (caught) {
    throw asGuestError(caught, path)
  }
  return typeof data === 'string' ? data.length : bytes.length
}

async function listEntries(bridge: BridgeDispatchFn, path: string): Promise<MirageEntryLike[]> {
  const prefix = path.endsWith('/') ? path : path + '/'
  let out: unknown
  try {
    out = await bridge('LIST', prefix)
  } catch (caught) {
    throw asGuestError(caught, path)
  }
  if (!Array.isArray(out)) throw new Error(`monty bridge: LIST ${prefix} expected array`)
  return out as MirageEntryLike[]
}

async function entryFor(bridge: BridgeDispatchFn, path: string): Promise<MirageEntryLike | null> {
  const slash = path.lastIndexOf('/')
  const parent = slash <= 0 ? '/' : path.slice(0, slash)
  const entries = await listEntries(bridge, parent)
  return entries.find((e) => e.path === path || e.path === path + '/') ?? null
}
