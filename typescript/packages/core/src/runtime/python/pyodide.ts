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
import { PrefixResolver, type MountResolver } from '../resolver.ts'
import type { BridgeDispatchFn } from '../types.ts'
import { RuntimeVFS } from '../vfs.ts'
import { applyMutation, createJournal, type MutationJournal } from './vfs/journal.ts'
import { preloadInto } from './vfs/preload.ts'
import { MirageFs } from './vfs/vfs.ts'
import { MirageFsSeed } from './vfs/seed.ts'
import { PYTHON_EVAL_WRAPPER, PYTHON_REPL_WRAPPER, PYTHON_WRAPPER } from './wrapper.ts'
import { unhonoredNotice, type InitFlags } from './flags.ts'

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
// them instead of pretending. See PYTHON_WRAPPER for what honoring the
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
 * writing MEMFS and a write reports success while the resource never
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
  'denyPackages',
  'home',
  'sysPath',
  'packages',
  'packageBaseUrl',
  'lockFileURL',
]

// Prepend, glob-expand, and invalidate. Three things are load-bearing.
// Prepending (not appending) lets a vendored package beat a bundled one
// of the same name, which is CPython's own PYTHONPATH precedence. A
// pattern that expands to nothing is collected into `_seed_misses` for
// the host to report, because a silent [] shows up much later as a bare
// ModuleNotFoundError with nothing pointing at the config; the seed
// cannot report it itself, since this runs inside syncMounts, where
// nothing is capturing sys.stderr yet. And invalidate_caches() runs
// UNCONDITIONALLY, because
// syncMounts remounts every prefix on every run: zipimport's archive
// table of contents is keyed by path rather than mtime, so a remounted
// wheel would otherwise keep serving the previous run's contents.
const SYS_PATH_SEED_PY = String.raw`
import sys, glob, importlib

_seed_misses = []
_expanded = []
for _p in _seed_paths:
    if any(c in _p for c in '*?['):
        _hits = sorted(glob.glob(_p))
        if not _hits:
            _seed_misses.append(_p)
        _expanded.extend(_hits)
    else:
        _expanded.append(_p)

_new = [p for p in _expanded if p not in sys.path]
if _new:
    sys.path[:0] = _new

importlib.invalidate_caches()
`

// One-shot eval is bounded like quickjs's: nothing above the runtime
// can stop a hung guest on this thread, so the runtime owns its own
// interrupt. Console (repl) sessions stay unbounded, matching python.
const EVAL_INTERRUPT_SECONDS = 10

export class PyodideRuntime extends PythonRuntime implements Evaluator {
  readonly name = 'pyodide'
  readonly [EVALUATOR] = true as const
  private pyodide: PyodideInterface | null = null
  private initPromise: Promise<PyodideInterface> | null = null
  private bootstrapPromise: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly autoLoadFromImports: boolean
  private readonly bootstrapCode: string | null
  private workspaceBridge: BridgeDispatchFn | null = null
  private readonly denyPackages: ReadonlySet<string>
  private resolver: MountResolver = new PrefixResolver(() => [])
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

  constructor(options: RuntimeOptions<PyodideConfig> = {}) {
    super(options, PYODIDE_CONFIG_KEYS)
    const config = this.config as PyodideConfig
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

  override attach(dispatch: BridgeDispatchFn, resolver: MountResolver): void {
    if (this.workspaceBridge === null) {
      this.workspaceBridge = dispatch
      this.resolver = resolver
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
      const flushFailures = await this.drainMutations()
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
      for (const failure of await this.drainMutations()) console.warn(failure)
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
    this.vfs = null
    this.mounted.clear()
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
      this.wireBridgeIfNeeded()
      await this.syncMounts(this.pyodide)
      await this.wireInterruptIfNeeded(this.pyodide)
      return this.pyodide
    }
    this.initPromise ??= loadPyodideRuntime({
      ...(this.home !== null ? { home: this.home } : {}),
      ...(this.packageBaseUrl !== null ? { packageBaseUrl: this.packageBaseUrl } : {}),
      ...(this.lockFileURL !== null ? { lockFileURL: this.lockFileURL } : {}),
      ...(this.packages.length > 0 ? { packages: this.packages } : {}),
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
    this.wireBridgeIfNeeded()
    await this.syncMounts(this.pyodide)
    await this.wireInterruptIfNeeded(this.pyodide)
    return this.pyodide
  }

  private wireBridgeIfNeeded(): void {
    if (this.workspaceBridge === null || this.vfs !== null) return
    this.vfs = new RuntimeVFS(this.workspaceBridge, this.resolver)
  }

  /**
   * Rebuild the guest's mount table from the workspace's, before every
   * run.
   *
   * Every prefix is re-seeded, not just a newly added one, because the
   * filesystem's callbacks are synchronous and so this is the only place
   * that can await the bridge at all. A stale snapshot is not merely a
   * missed read: a file the snapshot lacks looks like a new file, so
   * `open(path, 'a')` would start from an empty buffer and the flush
   * would replace content the guest never saw. Re-seeding is what keeps
   * that impossible without JSPI, which no shipping Node has and Safari
   * does not implement.
   *
   * The cost is one LIST plus one READ per file per run. Narrowing that
   * to what actually changed needs a per-entry change stamp the bridge
   * does not carry yet; until it does, correctness is the side to err on.
   *
   * A prefix the workspace has dropped is unmounted, so a removed mount
   * stops being visible instead of lingering for the interpreter's life.
   */
  private async syncMounts(pyodide: PyodideInterface): Promise<void> {
    const vfs = this.vfs
    if (vfs === null) return
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
      // Collect before touching the mount table: a failed LIST then
      // leaves the previous snapshot serving rather than an empty mount,
      // and the prefix retries on the next run.
      const seed = new MirageFsSeed()
      await preloadInto(seed, vfs, prefix)
      const mountpoint = mountpointOf(prefix)
      if (this.mounted.has(prefix)) pyodide.FS.unmount(mountpoint)
      const fs = new MirageFs(pyodide.FS, pyodide.ERRNO_CODES, this.journal, mountpoint, (p) =>
        vfs.mountOf(p),
      )
      pyodide.FS.mkdirTree(mountpoint)
      pyodide.FS.mount(fs.type, {}, mountpoint)
      // After the mount, never inside it: Emscripten assigns the root's
      // `mount` only once `type.mount()` has returned, and a node built
      // before that inherits an undefined one.
      fs.seed(seed)
      this.mounted.add(prefix)
    }
    await this.seedSysPath(pyodide)
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
  private async seedSysPath(pyodide: PyodideInterface): Promise<void> {
    if (this.sysPath.length === 0) return
    const seedPy = pyodide.toPy([...this.sysPath])
    pyodide.globals.set('_seed_paths', seedPy)
    try {
      await pyodide.runPythonAsync(SYS_PATH_SEED_PY)
      this.recordSeedMisses(pyodide)
    } finally {
      pyodide.globals.delete?.('_seed_paths')
      if (seedPy !== null && typeof seedPy === 'object' && 'destroy' in seedPy) {
        try {
          ;(seedPy as { destroy: () => void }).destroy()
        } catch {
          // destroy is best-effort; ignore double-destroy errors
        }
      }
    }
  }

  /**
   * Queue a notice for each glob that expanded to nothing this pass.
   *
   * The seed cannot report these itself: it runs inside syncMounts,
   * before the run's stdout/stderr are captured, so anything it wrote
   * to sys.stderr reached nobody. Queuing here and draining onto the
   * run's stderr puts the warning in front of the same agent whose
   * import is about to fail.
   *
   * Args:
   *   pyodide: the loaded interpreter, holding the seed's `_seed_misses`.
   */
  private recordSeedMisses(pyodide: PyodideInterface): void {
    const proxy = pyodide.globals.get('_seed_misses') as
      | { toJs?: () => unknown; destroy?: () => void }
      | null
      | undefined
    const misses = proxy?.toJs?.()
    proxy?.destroy?.()
    pyodide.globals.delete?.('_seed_misses')
    if (!Array.isArray(misses)) return
    for (const miss of misses as unknown[]) {
      const pattern = String(miss)
      if (this.seedMissesReported.has(pattern)) continue
      this.seedMissesReported.add(pattern)
      this.seedNotices.push(`python3: sysPath: '${pattern}' matched nothing`)
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
    const failures: string[] = []
    const pending = this.journal.takeMutations()
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

  private async runOne(args: RunArgs): Promise<RunResult> {
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
    const mergedEnv = { ...runtimeEnv(), ...args.env }
    // sys.argv[0] is the program's own name when the caller has one (a
    // CLI install's head word), else CPython's own -c spelling.
    const argv = [args.prog ?? '-c', ...args.args]
    const stdinBytes = args.stdin ?? new Uint8Array()

    const mergedEnvPy = pyodide.toPy(mergedEnv)
    const argvPy = pyodide.toPy(argv)
    const userGlobalsPy = pyodide.toPy({})

    const initFlagsPy = pyodide.toPy(args.flags ?? {})
    pyodide.globals.set('_user_code', args.code)
    pyodide.globals.set('_init_flags', initFlagsPy)
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
      const flushFailures = await this.drainMutations()
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
            [...seedNotices, ...flushFailures],
          ),
          exitCode: 1,
        }
      }
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
      const deadline = armed?.disarm() === 'deadline'
      for (const notice of [...seedNotices, ...(await this.drainMutations())]) console.warn(notice)
      if (deadline && args.timeoutSeconds !== undefined) {
        throw new CommandTimeoutError(this.name, args.timeoutSeconds)
      }
      throw err
    } finally {
      armed?.disarm()
      pyodide.globals.delete?.('_user_code')
      pyodide.globals.delete?.('_init_flags')
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
      maybeDestroy(initFlagsPy)
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
      const flushFailures = await this.drainMutations()
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
