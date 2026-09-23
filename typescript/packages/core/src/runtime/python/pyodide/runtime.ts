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

import { captureSessionContext } from '../../../context/session_context.ts'
import { captureRecordingContext } from '../../../observe/context.ts'
import { ContextScope } from '../../../utils/context_scope.ts'
import { CommandTimeoutError } from '../../../commands/errors.ts'
import { PythonRuntime } from '../base.ts'
import { EvalError } from '../../errors.ts'
import { EVALUATOR, type Evaluator } from '../../mixin.ts'
import type {
  EvalResult,
  EvalValue,
  RunArgs,
  RuntimeContext,
  RunResult,
  RuntimeOptions,
  RuntimeReach,
} from '../../types.ts'
import {
  createPyodideInterrupter,
  type ArmedInterrupt,
  type PyodideInterrupter,
} from './interrupt.ts'
import { loadPyodideRuntime, type PyodideInterface } from './loader.ts'
import { RuntimeVFS } from '../../vfs.ts'
import { applyMutation, createJournal, type MutationJournal } from './vfs/journal.ts'
import { preloadInto } from './vfs/preload.ts'
import { MirageFs } from './vfs/vfs.ts'
import { MirageFsSeed } from './vfs/seed.ts'
import { PyodideExecution } from './execution.ts'
import { unhonoredNotice, type InitFlags } from '../flags.ts'
import type { SyncVFS, XattrOp } from './vfs/types.ts'
import { classify } from '../../../errors/index.ts'
import { decodeBase64, encodeBase64 } from '../../../utils/base64.ts'
import { PyodideWorkerClient } from './worker/client.ts'

function bridgeBytes(value: Uint8Array | ArrayLike<number>): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

function bridgeStderr(value: Uint8Array | ArrayLike<number>): Uint8Array | null {
  const bytes = bridgeBytes(value)
  return bytes.length > 0 ? bytes : null
}

// The init switches this engine acts on, by CPython letter. The rest
// (-E, -I, -s, -S) only change how an interpreter *starts*, and this
// one is already running by the time a line is typed, so it reports
// them instead of pretending. See execution.py for what honoring the
// four below amounts to.
const HONORED_FLAGS: readonly string[] = ['B', 'O', 'W', 'X']

function decodeNoticeLines(notice: Uint8Array): string[] {
  if (notice.length === 0) return []
  return new TextDecoder()
    .decode(notice)
    .split('\n')
    .filter((line) => line.length > 0)
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

// Mount prefixes are normalized with a trailing slash; an Emscripten
// mountpoint is a directory path, so it carries none. The root prefix
// is the one that strips to nothing, and nothing is what makes it
// unmountable here: see `servable`.
function mountpointOf(prefix: string): string {
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
}

/**
 * Whether this runtime can mount `prefix` at all.
 *
 * Everything but the workspace root can. `/` cannot: it is already
 * MEMFS's own mount root, holding the interpreter's stdlib, and
 * Emscripten answers EBUSY to a second mount there. Left to itself
 * `mountpointOf` hands back the empty string, which mounts a detached
 * pseudo-filesystem no path reaches, so the guest keeps reading and
 * writing MEMFS and a write reports success while the VFS never
 * sees it.
 *
 * Args:
 *   prefix: a slash-terminated mount prefix.
 */
function servable(prefix: string): boolean {
  return mountpointOf(prefix) !== ''
}

/**
 * Drop every prefix nested inside another: only the shallowest of a
 * nested pair earns an Emscripten mountpoint, and its preload descends
 * into the child through the door's merged readdir.
 *
 * Args:
 *   prefixes: slash-terminated mount prefixes.
 */
function maximalPrefixes(prefixes: readonly string[]): string[] {
  const shallowFirst = [...prefixes].sort((a, b) => a.length - b.length)
  const out: string[] = []
  for (const p of shallowFirst) {
    if (out.some((kept) => p.startsWith(kept))) continue
    out.push(p)
  }
  return out
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
  /** Trusted host module URL. Its default initializer receives Pyodide and may return cleanup. */
  initModule?: string
  denyPackages?: readonly string[]
  /**
   * Virtual paths prepended to sys.path once the mounts are in place, so
   * an agent can `import openpyxl` without writing sys.path.append
   * itself. Entries are MOUNT paths, not host paths: the glob runs
   * inside the interpreter against the mounted tree. A `.whl` may be
   * named directly (zipimport reads a pure-python wheel in place), and a
   * pattern may contain `*`, `?` or `[`.
   *
   * Prepended, not appended: a vendored package of the same name must
   * win over a bundled one, which is also CPython's own PYTHONPATH
   * precedence.
   */
  sysPath?: readonly string[]
  /**
   * Packages loaded once at init from the pyodide distribution, before
   * the first run. Composes with autoLoadFromImports rather than
   * replacing it: the per-run import scan is a no-op for anything
   * already resident.
   */
  packages?: readonly string[]
  /**
   * Where package wheels are fetched from. Distinct from `home`, which
   * only sets indexURL: the npm pyodide package ships the lock file and
   * NO wheels, so a deployment that wants `packages` working offline
   * points this at its own prebuilt distribution. A `://` value makes
   * package loading a network fetch; a local path keeps it on disk.
   */
  packageBaseUrl?: string
  /** A custom pyodide-lock.json, for a prebuilt distribution. */
  lockFileURL?: string
  // Where the pyodide distribution loads from; falls back to
  // MIRAGE_PYODIDE_HOME, then the installed package in Node or the
  // pinned CDN in the browser. Override for self-hosted assets.
  home?: string
}

const PYODIDE_CONFIG_KEYS: readonly string[] = [
  'autoLoadFromImports',
  'bootstrapCode',
  'initModule',
  'denyPackages',
  'home',
  'sysPath',
  'packages',
  'packageBaseUrl',
  'lockFileURL',
]

// One-shot eval is bounded like quickjs's: nothing above the runtime
// can stop a hung guest on this thread, so the runtime owns its own
// interrupt. Console (repl) sessions stay unbounded, matching python.
const EVAL_INTERRUPT_SECONDS = 10

export class PyodideRuntime extends PythonRuntime implements Evaluator {
  readonly name = 'pyodide'
  protected override readonly versionSuffix = ' (pyodide)'
  // The WASM guest's filesystem is the workspace-backed Emscripten FS,
  // so file effects pass the workspace gate, and loader.ts seals the
  // `js` module (null-prototype jsglobals) so guest code cannot reach
  // js.process or js.fetch either. Both doors closed is what makes this
  // 'workspace' unless a trusted initializer installs host capabilities.
  override readonly reach: RuntimeReach
  override readonly filesystem = ['read', 'write', 'list', 'stat', 'glob'] as const
  readonly [EVALUATOR] = true as const
  private pyodide: PyodideInterface | null = null
  private guest: PyodideExecution | null = null
  private initPromise: Promise<PyodideInterface> | null = null
  private bootstrapPromise: Promise<void> | null = null
  private disposeModule: (() => void | Promise<void>) | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly autoLoadFromImports: boolean
  private readonly bootstrapCode: string | null
  private readonly denyPackages: ReadonlySet<string>
  private readonly home: string | null
  private readonly sysPath: readonly string[]
  private readonly packages: readonly string[]
  private readonly packageBaseUrl: string | null
  private readonly lockFileURL: string | null
  private vfs: RuntimeVFS | null = null
  private readonly journal: MutationJournal = createJournal()
  private readonly mounted = new Set<string>()
  // Prefixes this runtime cannot mount, remembered so the refusal is
  // reported once rather than on every run.
  private readonly refused = new Set<string>()
  // Same rule for a sysPath glob that expanded to nothing. Seeding runs
  // on every syncMounts pass, so without this a misconfigured pattern
  // would warn on every line the agent types; and a pattern can start
  // matching later (the wheels are written to the mount after boot),
  // which is why the miss is reported rather than refused.
  private readonly seedMissesReported = new Set<string>()
  private seedNotices: string[] = []
  // The guest executes on this event loop, so only the watchdog-backed
  // interrupt buffer can stop a busy loop (see interrupt.ts); null
  // where SharedArrayBuffer/workers are unavailable (runs unbounded).
  private interrupter: PyodideInterrupter | null = null
  private interrupterTried = false
  private worker: Promise<PyodideWorkerClient | null> | null = null
  private readonly syncFailures: string[] = []
  private syncSkipped = 0

  constructor(
    options: RuntimeOptions<PyodideConfig> = {},
    private readonly sync?: SyncVFS,
    private readonly interruptBuffer?: SharedArrayBuffer,
  ) {
    super(options, PYODIDE_CONFIG_KEYS)
    const config = this.config as PyodideConfig
    this.reach = config.initModule === undefined ? 'workspace' : 'process'
    this.autoLoadFromImports = config.autoLoadFromImports ?? true
    this.bootstrapCode = config.bootstrapCode ?? null
    this.denyPackages = new Set(config.denyPackages ?? [])
    this.home = config.home ?? null
    this.sysPath = config.sysPath ?? []
    this.packages = config.packages ?? []
    this.packageBaseUrl = config.packageBaseUrl ?? null
    this.lockFileURL = config.lockFileURL ?? null
    const denied = new Set(this.denyPackages)
    const contradictory = this.packages.filter((name) => denied.has(name))
    if (contradictory.length > 0) {
      throw new Error(
        `pyodide config: ${contradictory.map((n) => `'${n}'`).join(', ')} ` +
          `appears in both packages and denyPackages`,
      )
    }
  }

  protected override executeCode(args: RunArgs, context?: RuntimeContext): Promise<RunResult> {
    return this.run(args, context)
  }

  async run(args: RunArgs, context = this.captureContext()): Promise<RunResult> {
    const scope =
      context?.scope ?? new ContextScope([...captureSessionContext(), ...captureRecordingContext()])
    const task = (): Promise<RunResult> => scope.run(() => this.runOne(args, context))
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
    const context = this.captureContext()
    const scope =
      context?.scope ?? new ContextScope([...captureSessionContext(), ...captureRecordingContext()])
    const task = (): Promise<EvalResult> => scope.run(() => this.evalOne(code, opts, context))
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async evalOne(
    code: string,
    opts: { inputs?: Record<string, EvalValue>; session?: string },
    context?: RuntimeContext,
  ): Promise<EvalResult> {
    this.vfs = context !== undefined ? new RuntimeVFS(context.dispatch, context.resolver) : null
    const worker = await this.ensureWorker(context)
    if (worker !== null && context !== undefined) {
      return (await worker.execute(
        {
          kind: 'execute',
          method: 'eval',
          config: this.config as PyodideConfig,
          prefixes: context.resolver.prefixes(),
          code,
          ...opts,
        },
        context,
      )) as EvalResult
    }
    if (opts.session !== undefined) {
      const repl = await this.runOneRepl(code, opts.session, opts.inputs ?? {})
      return { value: null, ...repl }
    }
    const pyodide = await this.ensureLoaded()
    await this.loadImports(pyodide, code)
    const armed = this.interrupter !== null ? this.interrupter.arm(EVAL_INTERRUPT_SECONDS) : null
    try {
      const arr = this.guestModule(pyodide).evaluate(code, opts.inputs ?? {})
      if (armed?.disarm() === 'deadline') {
        throw new EvalError(`pyodide eval timed out after ${String(EVAL_INTERRUPT_SECONDS)}s`)
      }
      const flushFailures = await this.drainMutations()
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
      for (const failure of await this.drainMutations()) console.warn(failure)
      if (deadline) {
        throw new EvalError(`pyodide eval timed out after ${String(EVAL_INTERRUPT_SECONDS)}s`, {
          cause: err,
        })
      }
      throw err
    } finally {
      armed?.disarm()
    }
  }

  override close(): Promise<void> {
    const task = (): Promise<void> => this.closeOne()
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async closeOne(): Promise<void> {
    this.guest?.close()
    this.guest = null
    const dispose = this.disposeModule
    this.disposeModule = null
    try {
      await dispose?.()
    } finally {
      this.bootstrapPromise = null
      this.pyodide = null
      const worker = this.worker
      this.worker = null
      this.initPromise = null
      this.vfs = null
      this.mounted.clear()
      try {
        ;(await worker)?.close()
      } finally {
        this.interrupter?.close()
        this.interrupter = null
        this.interrupterTried = false
      }
    }
  }

  private async wireInterruptIfNeeded(pyodide: PyodideInterface): Promise<void> {
    if (this.interrupterTried || pyodide.setInterruptBuffer === undefined) return
    this.interrupter = await createPyodideInterrupter(this.interruptBuffer)
    this.interrupterTried = true
    if (this.interrupter !== null) pyodide.setInterruptBuffer(this.interrupter.view)
  }

  private async ensureLoaded(): Promise<PyodideInterface> {
    if (this.pyodide !== null) {
      if (this.bootstrapPromise !== null) await this.bootstrapPromise
      await this.syncMounts(this.pyodide)
      await this.wireInterruptIfNeeded(this.pyodide)
      return this.pyodide
    }
    this.initPromise ??= loadPyodideRuntime({
      ...(this.home !== null ? { home: this.home } : {}),
      ...(this.packageBaseUrl !== null ? { packageBaseUrl: this.packageBaseUrl } : {}),
      ...(this.lockFileURL !== null ? { lockFileURL: this.lockFileURL } : {}),
      ...(this.packages.length > 0 ? { packages: this.packages } : {}),
    }).then(async (py) => {
      const ref = (this.config as PyodideConfig).initModule
      if (ref !== undefined) {
        const module = (await import(ref)) as {
          default: (runtime: PyodideInterface) => unknown
        }
        if (typeof module.default !== 'function') {
          throw new TypeError('pyodide initModule must export a default initializer')
        }
        const dispose = await module.default(py)
        if (dispose !== undefined && typeof dispose !== 'function') {
          throw new TypeError('pyodide initModule must return a cleanup function or undefined')
        }
        this.disposeModule = (dispose as (() => void | Promise<void>) | undefined) ?? null
      }
      return py
    })
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
    await this.syncMounts(this.pyodide)
    await this.wireInterruptIfNeeded(this.pyodide)
    return this.pyodide
  }

  private async ensureWorker(context?: RuntimeContext): Promise<PyodideWorkerClient | null> {
    if (this.sync !== undefined || context === undefined || this.pyodide !== null) return null
    this.worker ??= PyodideWorkerClient.create()
    return this.worker
  }

  /**
   * Rebuild mount nodes before each run so cached bytes never survive a
   * session change. Workers populate nodes on lookup/open; the fallback
   * for hosts without shared memory collects a complete seed instead.
   * Removed mounts disappear, and nested mounts share their parent's
   * Emscripten mountpoint while retaining workspace routing boundaries.
   */
  private async syncMounts(pyodide: PyodideInterface): Promise<void> {
    const vfs = this.vfs
    if (vfs === null) return
    const sync = this.sync
    const all = vfs.prefixes()
    for (const prefix of all) {
      if (servable(prefix) || this.refused.has(prefix)) continue
      this.refused.add(prefix)
      console.warn(
        `mirage: the ${this.name} runtime cannot serve a mount at ` +
          `'${prefix}', because that is the interpreter's own filesystem ` +
          `root; python will not see it`,
      )
    }
    // Only maximal prefixes become Emscripten mounts: the bridge routes
    // every op by full path and the door's readdir lists a nested
    // mount's name under its parent, so a child mount is served through
    // the parent's mountpoint. A second Emscripten mount inside the
    // first would be orphaned when the parent remounts.
    const wanted = new Set(maximalPrefixes(all.filter(servable)))
    for (const prefix of [...this.mounted].sort((a, b) => b.length - a.length)) {
      if (wanted.has(prefix)) continue
      pyodide.FS.unmount(mountpointOf(prefix))
      this.mounted.delete(prefix)
    }
    for (const prefix of [...wanted].sort((a, b) => a.length - b.length)) {
      // Collect before touching the mount table: a failed readdir then
      // leaves the previous snapshot serving rather than an empty mount,
      // and the prefix retries on the next run.
      const seed = new MirageFsSeed()
      if (this.sync === undefined) await preloadInto(seed, vfs, prefix)
      const mountpoint = mountpointOf(prefix)
      if (this.mounted.has(prefix)) pyodide.FS.unmount(mountpoint)
      const fs = new MirageFs(
        pyodide.FS,
        pyodide.ERRNO_CODES,
        this.journal,
        mountpoint,
        (p) => vfs.mountOf(p),
        sync === undefined
          ? undefined
          : {
              ...sync,
              flush: (mutations) => {
                if (this.syncFailures.length > 0) {
                  this.syncSkipped += mutations.length
                  throw new Error(this.syncFailures[0])
                }
                try {
                  const failure = sync.flush(mutations)
                  if (failure !== undefined) {
                    this.syncSkipped += failure.skipped
                    throw new Error(failure.message)
                  }
                } catch (error) {
                  this.syncFailures.push(error instanceof Error ? error.message : String(error))
                  throw error
                }
              },
            },
      )
      pyodide.FS.mkdirTree(mountpoint)
      pyodide.FS.mount(fs.type, {}, mountpoint)
      // After the mount, never inside it: Emscripten assigns the root's
      // `mount` only once `type.mount()` has returned, and a node built
      // before that inherits an undefined one.
      fs.seed(seed)
      this.mounted.add(prefix)
    }
    this.seedSysPath(pyodide)
  }

  /**
   * Put the configured paths on sys.path, after every mount is in place.
   *
   * Runs on EVERY syncMounts pass rather than once at load: each pass
   * unmounts and remounts the prefixes, and zipimport caches an
   * archive's table of contents by path, so a `.whl` served from a
   * remounted tree would keep answering from the previous run. Both
   * guards inside are idempotent, so repeating is cheap.
   *
   * Args:
   *   pyodide: the loaded interpreter.
   */
  private seedSysPath(pyodide: PyodideInterface): void {
    for (const pattern of this.guestModule(pyodide).seedSysPath(this.sysPath)) {
      if (this.seedMissesReported.has(pattern)) continue
      this.seedMissesReported.add(pattern)
      this.seedNotices.push(`python3: sysPath: '${pattern}' matched nothing`)
    }
  }

  private guestModule(pyodide: PyodideInterface): PyodideExecution {
    this.guest ??= new PyodideExecution(pyodide, this.guestXattr.bind(this))
    return this.guest
  }

  /**
   * The guest's extended-attribute calls (its os.getxattr family, which
   * the harness installs over this module), answered by the workspace
   * door and handed back as JSON: `{value}`, or `{code}` naming the
   * condition the door reported. Only the worker can wait on the door
   * from inside a WASM frame, so without one, and for a path no mount
   * serves, the answer is ENOTSUP: what a filesystem without extended
   * attributes says.
   */
  private guestXattr(
    op: XattrOp,
    path: string,
    name: string | null | undefined,
    value: string | null | undefined,
    create: boolean,
    replace: boolean,
    nofollow: boolean,
  ): string {
    const sync = this.sync
    if (sync === undefined || this.vfs?.mountOf(path) == null) {
      return JSON.stringify({ code: 'ENOTSUP' })
    }
    try {
      const bytes = value == null ? undefined : decodeBase64(value)
      const out = sync.xattr(op, path, name ?? undefined, bytes, { create, replace, nofollow })
      return JSON.stringify({
        value: out instanceof Uint8Array ? encodeBase64(out) : (out ?? null),
      })
    } catch (err) {
      return JSON.stringify({ code: (err as { code?: unknown }).code ?? classify(err) ?? 'EIO' })
    }
  }

  private takeSeedNotices(): string[] {
    const notices = this.seedNotices
    this.seedNotices = []
    return notices
  }

  /**
   * Replay every mutation the shim recorded during the run, in the order
   * the guest performed them. The guest cannot await the bridge from its
   * sync WASM frames without JSPI, so it only records; ordering is what
   * makes a create-then-rename or mkdir-then-write sequence land the same
   * way it ran. Returns one message per failure for the caller's stderr.
   */
  private async drainMutations(): Promise<string[]> {
    const vfs = this.vfs
    if (vfs === null) return []
    const failures = this.syncFailures.splice(0)
    const pending = this.journal.takeMutations()
    const skipped = this.syncSkipped + pending.length
    this.syncSkipped = 0
    if (failures.length > 0) {
      if (skipped > 0)
        failures.push(`python3: skipped ${String(skipped)} later mutation(s) after that failure`)
      return failures
    }
    for (let i = 0; i < pending.length; i++) {
      const mutation = pending[i]
      if (mutation === undefined) continue
      try {
        await applyMutation(vfs, mutation)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        failures.push(`python3: failed to ${mutation.kind} ${mutation.path} on mount: ${detail}`)
        // Stop: the journal is a sequence, not a set. Replaying past a
        // failure applies later entries against a prerequisite that was
        // never established, which can put the mount in a state the guest
        // never produced (a rename landing on a temp file the failed write
        // left stale). Report what was dropped rather than truncating
        // silently.
        const dropped = pending.length - i - 1
        if (dropped > 0) {
          failures.push(`python3: skipped ${String(dropped)} later mutation(s) after that failure`)
        }
        break
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

  private async runOne(args: RunArgs, context?: RuntimeContext): Promise<RunResult> {
    this.vfs = context !== undefined ? new RuntimeVFS(context.dispatch, context.resolver) : null
    const worker = await this.ensureWorker(context)
    if (worker !== null && context !== undefined) {
      const { cwd, signal, ...rest } = args
      return (await worker.execute(
        {
          kind: 'execute',
          method: 'run',
          config: this.config as PyodideConfig,
          prefixes: context.resolver.prefixes(),
          args: { ...rest, ...(cwd !== undefined ? { cwd: cwd.virtual } : {}) },
        },
        context,
        signal,
      )) as RunResult
    }
    const pyodide = await this.ensureLoaded()
    // Seeding happened inside ensureLoaded; its notices ride out on
    // this run's stderr, beside any flush failure and any init switch
    // this engine could not act on.
    const seedNotices = [
      ...this.takeSeedNotices(),
      ...decodeNoticeLines(
        unhonoredNotice((args.flags ?? {}) as InitFlags, this.name, HONORED_FLAGS),
      ),
    ]
    await this.loadImports(pyodide, args.code)
    // sys.argv[0] is the program's own name when the caller has one (a
    // CLI install's head word), else CPython's own -c spelling.
    const argv = [args.prog ?? '-c', ...args.args]
    const cwd = args.cwd?.virtual ?? ''
    const cwdMount = cwd === '' ? null : (this.vfs?.mountOf(cwd) ?? null)
    const request = {
      code: args.code,
      argv,
      env: { ...args.env },
      stdin: args.stdin,
      flags: args.flags ?? {},
      script_cli: args.scriptCli ?? false,
      // A root mount cannot replace the interpreter's own filesystem.
      cwd: cwd !== '/' && cwdMount !== null && !servable(cwdMount) ? '' : cwd,
    }

    // Deadline trip -> exit 124 via CommandTimeoutError; a kill signal
    // raises KeyboardInterrupt in the guest, whose wrapper-reported
    // exit code (1) stands, like the local runtime's killed child.
    // The wrapper arms right before the user code and disarms right
    // after it, so a trip can only land inside the wrapper's own
    // handlers, never in its preamble or epilogue where it would escape
    // as a KeyboardInterrupt nothing catches and the deadline is lost.
    const slot: { armed: ArmedInterrupt | null } = { armed: null }
    const arm = (): void => {
      if (this.interrupter !== null && slot.armed === null) {
        slot.armed = this.interrupter.arm(args.timeoutSeconds ?? null, args.signal)
      }
    }
    const disarm = (): void => {
      slot.armed?.disarm()
    }
    try {
      const arr = this.guestModule(pyodide).run(request, arm, disarm)
      if (slot.armed?.disarm() === 'deadline' && args.timeoutSeconds !== undefined) {
        throw new CommandTimeoutError(this.name, args.timeoutSeconds)
      }
      const flushFailures = await this.drainMutations()
      return {
        stdout: bridgeBytes(arr[0]),
        // A seed notice rides on stderr but never on the exit code: an
        // unmatched glob is a warning about the environment, not a
        // failure of the program that just ran.
        stderr: appendStderrLines(bridgeStderr(arr[1]), [...seedNotices, ...flushFailures]),
        exitCode: flushFailures.length > 0 && arr[2] === 0 ? 1 : arr[2],
      }
    } catch (err) {
      // The interrupt can also fire between wrapper statements, where
      // KeyboardInterrupt escapes as a rejection instead of a result.
      // Files closed before the failure are complete in MEMFS, so their
      // marks still flush; failures can only be warned here.
      const deadline = slot.armed?.disarm() === 'deadline'
      for (const notice of [...seedNotices, ...(await this.drainMutations())]) console.warn(notice)
      if (deadline && args.timeoutSeconds !== undefined) {
        throw new CommandTimeoutError(this.name, args.timeoutSeconds)
      }
      throw err
    } finally {
      slot.armed?.disarm()
    }
  }

  private async runOneRepl(
    code: string,
    sessionId: string,
    inputs: Record<string, EvalValue> = {},
  ): Promise<Omit<EvalResult, 'value'>> {
    const pyodide = await this.ensureLoaded()
    await this.loadImports(pyodide, code)

    const arr = this.guestModule(pyodide).repl(code, sessionId, inputs)
    const flushFailures = await this.drainMutations()
    return {
      stdout: bridgeBytes(arr[0]),
      stderr: appendStderrLines(bridgeStderr(arr[1]), flushFailures),
      exitCode: flushFailures.length > 0 && arr[2] === 0 ? 1 : arr[2],
      status: arr[3],
    }
  }
}
