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
import type { EvalResult, EvalValue, RunArgs, RunResult, RuntimeOptions } from '../types.ts'
import type { BridgeDispatchFn } from '../types.ts'
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
  readonly workerPid?: number
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

// One-shot eval is bounded like quickjs's: nothing above the runtime
// can stop a hung guest, so the runtime owns its own interrupt.
const EVAL_INTERRUPT_SECONDS = 10

const INTERRUPTED = Symbol('interrupted')

interface RunInterruption {
  promise: Promise<typeof INTERRUPTED>
  timedOut: { value: boolean }
  dispose: () => void
}

/**
 * Hard-stop one monty worker. The binding offers no cancel: feedRun
 * has no signal and session.close() waits for the in-flight turn
 * (probed live), so the only way to stop a busy guest is to kill its
 * worker process — which poisons the session (the pool discards and
 * replaces the worker) and settles the pending feedRun. The pid is
 * only readable while the session is idle, so callers capture it
 * before feeding. Python needs none of this: cancelling run_async
 * halts the interpreter.
 */
function killWorker(pid: number | undefined): void {
  if (pid === undefined) return
  const proc = (globalThis as { process?: { kill?: (pid: number, signal?: string) => void } })
    .process
  if (typeof proc?.kill !== 'function') return
  try {
    proc.kill(pid, 'SIGKILL')
  } catch {
    // the worker may already have exited; nothing left to reclaim
  }
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
 * environment, or network access. `pathlib` I/O is serviced through the
 * workspace bridge, so the code sees the workspace mounts and nothing
 * else, and the run's env is readable both ways python's monty spells
 * it: `os.getenv` and `os.environ` (a dict copy, so the two hosts run
 * the same program). Command-line arguments are exposed as the
 * `argv` global (`argv[0]` is the script name) and piped input as the
 * `stdin` global (bytes, None when nothing was piped). Monty implements
 * a Python subset; host-only features (`sys.stdin`, `sys.argv`,
 * third-party imports) are unavailable, and the builtin `open()` is not
 * bridgeable yet (the JS binding cannot return a file handle from an
 * `os` callback) — use `pathlib` for file I/O, or the pyodide runtime.
 */
export class MontyRuntime extends PythonRuntime implements Evaluator {
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
    // Monty executes on its own worker process, so the event loop stays
    // live to observe the limit deadline and the kill signal; a trip
    // SIGKILLs the worker (see killWorker). Deadline -> exit 124 via
    // CommandTimeoutError, kill -> exit 1 like the local runtime.
    const workerPid = session.workerPid
    const interruption = this.installInterruption(args.signal, args.timeoutSeconds)
    try {
      const run = this.feedOne(session, args.code, args)
      const winner = await Promise.race([run, interruption.promise])
      if (winner !== INTERRUPTED) return winner
      run.catch(() => undefined)
      killWorker(workerPid)
      if (interruption.timedOut.value && args.timeoutSeconds !== undefined) {
        throw new CommandTimeoutError(this.name, args.timeoutSeconds)
      }
      return { stdout: new Uint8Array(), stderr: null, exitCode: 1 }
    } finally {
      interruption.dispose()
      await session.close()
    }
  }

  private installInterruption(
    signal: AbortSignal | undefined,
    timeoutSeconds: number | undefined,
  ): RunInterruption {
    const timedOut = { value: false }
    let timer: ReturnType<typeof setTimeout> | null = null
    let removeAbort: (() => void) | null = null
    const promise = new Promise<typeof INTERRUPTED>((resolve) => {
      if (timeoutSeconds !== undefined && timeoutSeconds > 0) {
        timer = setTimeout(() => {
          timedOut.value = true
          resolve(INTERRUPTED)
        }, timeoutSeconds * 1000)
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          resolve(INTERRUPTED)
          return
        }
        const onAbort = (): void => {
          resolve(INTERRUPTED)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        removeAbort = () => {
          signal.removeEventListener('abort', onAbort)
        }
      }
    })
    return {
      promise,
      timedOut,
      dispose: () => {
        if (timer !== null) clearTimeout(timer)
        if (removeAbort !== null) removeAbort()
      },
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
    // One-shot evals get the quickjs-style 10s bound (the policy layer
    // above times out but cannot stop the worker; SIGKILLing it does).
    // Console sessions stay unbounded, matching python where
    // cancellation is ambient.
    const workerPid = session.workerPid
    const interruption =
      opts.session === undefined
        ? this.installInterruption(undefined, EVAL_INTERRUPT_SECONDS)
        : null
    try {
      const fed = session.feedRun(code, options)
      const winner =
        interruption !== null ? await Promise.race([fed, interruption.promise]) : await fed
      if (winner === INTERRUPTED) {
        fed.catch(() => undefined)
        killWorker(workerPid)
        throw new EvalError(`monty eval timed out after ${String(EVAL_INTERRUPT_SECONDS)}s`)
      }
      const value = toEvalValue(winner)
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
      interruption?.dispose()
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
      // argv[0] is the program's own name when the caller has one (a
      // CLI install's head word), else the interpreter's placeholder.
      inputs: { argv: [args.prog ?? 'main.py', ...args.args], stdin: args.stdin },
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
        // hasOwn, not `in`: the guest picks the key, so a name like
        // `toString` must miss instead of leaking a host function.
        const key = String(args[0])
        if (Object.hasOwn(env, key)) return env[key]
        return args.length > 1 ? args[1] : null
      }
      if (name === 'os.environ') {
        // The engine asks for the whole mapping as one call; a plain
        // object arrives in the guest as a dict, so `.get`, `[...]`,
        // `in`, iteration and len all work, and a missing key raises
        // KeyError. Declining instead raised "'os.environ' is not
        // supported in this environment", which made a program written
        // against the python host fail here (integ/runtime caught it).
        // A copy, like python's OSAccess(environ=dict(environ)): a
        // guest that mutates it cannot reach the session's own env.
        return { ...env }
      }
      // Everything below serves a path through the workspace bridge;
      // the env doors above need no mount.
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
        case 'Path.mkdir':
          return mutate(bridge, 'MKDIR', path)
        case 'Path.rmdir':
          return mutate(bridge, 'RMDIR', path)
        case 'Path.unlink':
          return mutate(bridge, 'UNLINK', path)
        case 'Path.rename': {
          const dst = pathArg(args[1])
          // A destination outside the workspace has no mount to rename
          // into; decline rather than half-apply the move.
          if (dst === null || !this.underWorkspaceMount(dst)) return notHandled
          // The dispatcher picks the mount from the source alone and
          // reads the destination against that same backend, so a
          // cross-mount rename would drop the source and write the
          // target into the wrong store. POSIX answers this with
          // EXDEV, which is also what tells a caller to copy instead.
          if (this.mountOf(path) !== this.mountOf(dst)) {
            return Promise.reject(guestError('EXDEV', path, dst))
          }
          return mutate(bridge, 'RENAME', path, dst)
        }
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

  /**
   * The mount prefix serving `path`, longest match first, or null when
   * none does. Two paths belong to the same mount only when this
   * agrees for both, which is what a rename needs to know.
   */
  private mountOf(path: string): string | null {
    let best: string | null = null
    for (const p of this.listMounts()) {
      const norm = p.endsWith('/') ? p : p + '/'
      if (path.startsWith(norm) || path === norm.slice(0, -1)) {
        if (best === null || norm.length > best.length) best = norm
      }
    }
    return best
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
const CODE_TO_GUEST_EXC = {
  ENOENT: { name: 'FileNotFoundError', errno: 2, phrase: 'No such file or directory' },
  EISDIR: { name: 'IsADirectoryError', errno: 21, phrase: 'Is a directory' },
  ENOTDIR: { name: 'NotADirectoryError', errno: 20, phrase: 'Not a directory' },
  EACCES: { name: 'PermissionError', errno: 13, phrase: 'Permission denied' },
  EEXIST: { name: 'FileExistsError', errno: 17, phrase: 'File exists' },
  EXDEV: { name: 'OSError', errno: 18, phrase: 'Invalid cross-device link' },
} as const

type GuestCode = keyof typeof CODE_TO_GUEST_EXC

function isGuestCode(code: string | undefined): code is GuestCode {
  return code !== undefined && code in CODE_TO_GUEST_EXC
}

/**
 * Build the guest-side exception for one fs code, in CPython's message
 * shape. `target` renders rename's two-path form.
 *
 * Args:
 *   code: the fs error code, e.g. ENOENT.
 *   path: the path the operation names.
 *   target: rename's destination, when there is one.
 */
function guestError(code: GuestCode, path: string, target?: string): Error {
  const mapped = CODE_TO_GUEST_EXC[code]
  const where = target === undefined ? `'${path}'` : `'${path}' -> '${target}'`
  const guest = new Error(`[Errno ${String(mapped.errno)}] ${mapped.phrase}: ${where}`)
  guest.name = mapped.name
  return guest
}

/**
 * Re-throw a bridge failure under its python exception name: the monty
 * binding raises `err.name` as the matching guest exception type
 * (PYTHON_EXC_NAMES), so agent code can `except FileNotFoundError`
 * exactly as it does on the python host.
 */
function asGuestError(err: unknown, path: string): unknown {
  const code = (err as { code?: string }).code
  if (!isGuestCode(code)) return err
  return guestError(code, path)
}

/**
 * Run one mutating bridge op, translating a coded failure the way the
 * read and write helpers do. Without this the raw workspace error
 * reaches monty with `name` still `Error`, so guest code cannot catch
 * the `FileNotFoundError` or `FileExistsError` the operation implies.
 *
 * Args:
 *   bridge: the workspace dispatch callable.
 *   op: the mutation to run.
 *   path: the path the operation names.
 *   dst: rename's destination.
 */
async function mutate(
  bridge: BridgeDispatchFn,
  op: 'MKDIR' | 'RMDIR' | 'UNLINK' | 'RENAME',
  path: string,
  dst?: string,
): Promise<null> {
  try {
    await bridge(op, path, undefined, dst)
  } catch (caught) {
    throw asGuestError(caught, path)
  }
  return null
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
