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

import { ContextScope } from '../../utils/context_scope.ts'
import {
  captureSessionContext,
  effectiveMountMode,
  requirePathsWritable,
  runWithMountGate,
  runWithWalkProbe,
  strongestModeUnder,
} from '../../context/session_context.ts'
import { captureOpPolicies } from '../../policy/policies.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { coerceReadPolicy } from './read_policy.ts'
import { KeyLock } from '../../cache/lock.ts'
import type { IndexConfig } from '../../cache/index/config.ts'
import { buildIndex } from '../../cache/index/factory.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type {
  CommandFnResult,
  CommandOpts,
  ExecContext,
  Command,
  CommandIO,
} from '../../commands/config.ts'
import { STDIN_DASH_COMMANDS, STDIN_DASH_LEADING } from '../../commands/spec/constants.ts'
import { hasInjectedVersion } from '../../commands/spec/standard.ts'
import { ROOT_CWD } from '../../commands/constants.ts'
import type { LinkView, OpKwargs } from '../../doors/types.ts'
import { commandIo, resolveGlobOf } from '../../commands/builtin/generic_bind/adapter.ts'
import {
  appendByRewrite,
  expectOffset,
  pwriteByRewrite,
  refuseTaken,
} from '../../core/generic/rewrite.ts'
import { callEffect } from '../../vfs/call.ts'
import { Effect } from '../../vfs/types.ts'
import { isUnsatisfiableRange, sliceWindow } from '../../utils/ranges.ts'

import { getExtension } from '../../commands/resolve.ts'
import { resolveLimit } from '../../policy/index.ts'
import { runWithTimeout } from '../../commands/builtin/utils/limit.ts'
import { CommandTimeoutError, UsageError } from '../../commands/errors.ts'
import { readFailExitCode } from '../../commands/spec/usage.ts'
import { materialize, type ByteSource, IOResult } from '../../io/types.ts'
import { flagOccurrences } from '../../commands/spec/flag_view.ts'
import type { CommandSpec, FlagValue } from '../../commands/spec/types.ts'
import { CachableAsyncIterator } from '../../io/cachable_iterator.ts'
import { captureCacheContext, runWithCacheManager } from '../../cache/context.ts'
import { captureCommandScope } from '../../cache/index/scope.ts'
import type { CacheManager } from '../../cache/manager.ts'
import { mergeSignals } from '../abort.ts'
import {
  captureRecordingContext,
  runWithMountContext,
  runWithRevisions,
  withMountContext,
} from '../../observe/context.ts'
import { uuid7 } from '../../utils/ids.ts'
import { VFSActivity } from './activity.ts'
import type { BaseVFS } from '../../vfs/base.ts'
import {
  type Limit,
  type ReadSpec,
  type SetAttrFields,
  DEFAULT_READ_SPEC,
  FileType,
  MountMode,
  PathSpec,
} from '../../types.ts'
import { ebusy, enotsup } from '../../errors/fs.ts'
import { formatFsError } from '../../errors/render.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { dispatchStat, linkFollow } from '../../commands/builtin/utils/paths.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { encodeText } from '../../shell/bytes.ts'

type CmdKey = string

/**
 * One way to answer an op on a mount: the scope keyed below the mount, the
 * op's positional arguments and its keywords.
 */
type OpCall = (scope: PathSpec, args: readonly unknown[], kwargs: OpKwargs) => unknown

type ReadFn = (
  path: PathSpec,
  index?: IndexCacheStore,
  offset?: number,
  size?: number | null,
) => Promise<Uint8Array>

// Ops that mutate everything under their endpoints in one backend call
// (a directory rename relocates its whole subtree), so the door also
// refuses a read-only region below either endpoint. The removal ops
// stay per-path: the runtimes compose rmtree from unlink/rmdir, and
// each of those answers for its own path above.
const SUBTREE_OPS = new Set(['rename'])

function cmdKey(name: string, filetype: string | null): CmdKey {
  return `${name}\u0000${filetype ?? ''}`
}

function writeData(args: readonly unknown[]): Uint8Array {
  const first = args[0]
  if (first instanceof Uint8Array) return first
  throw new TypeError('write op requires a Uint8Array as the first arg')
}

function lengthArg(value: unknown): number {
  if (typeof value !== 'number') {
    throw new TypeError('truncate op requires a number length as the first arg')
  }
  return value
}

function offsetArg(value: unknown, path: PathSpec): number {
  if (typeof value !== 'number') {
    throw new TypeError('pwrite op requires a number offset as the second arg')
  }
  return expectOffset(value, path)
}

function dstArg(value: unknown): PathSpec {
  if (!(value instanceof PathSpec)) {
    throw new TypeError('rename op requires a dst PathSpec as the first arg')
  }
  return value
}

/**
 * A read, honoring a byte window when one is asked for.
 *
 * A VFS that reads ranges natively fetches only the window, which is the
 * whole point on an object store: one ranged GET instead of the whole file.
 * Every other read is whole and sliced, which is the only meaningful
 * behavior for content that is rendered rather than stored. A zero-length
 * read is answered here rather than sent anywhere, and a window starting at
 * or past EOF answers empty, the POSIX answer, where an HTTP store refuses
 * with 416: normalizing here keeps the op's contract one thing whichever
 * path answers it. Mirrors Python's `_read_window`.
 */
async function readWindow(
  read: ReadFn,
  ranges: boolean,
  path: PathSpec,
  kwargs: OpKwargs,
): Promise<Uint8Array> {
  const offset = typeof kwargs.offset === 'number' ? kwargs.offset : 0
  const size = typeof kwargs.size === 'number' ? kwargs.size : null
  if (size === 0) return new Uint8Array(0)
  const whole = offset === 0 && size === null
  if (ranges && !whole) {
    try {
      return await read(path, kwargs.index, offset, size)
    } catch (err) {
      if (!isUnsatisfiableRange(err)) throw err
      return new Uint8Array(0)
    }
  }
  const data = await read(path, kwargs.index)
  return whole ? data : sliceWindow(data, offset, size)
}

export interface MountInit {
  prefix: string
  vfs: BaseVFS
  mode?: MountMode
  /** How this mount's cached bytes are revalidated. */
  read?: ReadSpec
  // The store this mount runs its driver under; the registry builds
  // one, shared with any alias of the same instance. A bare entry gets
  // a RAM store at the driver's TTL.
  index?: IndexCacheStore
  indexConfig?: IndexConfig | undefined
  // The `vfs:` value the driver was built from, recorded for snapshots;
  // null for one constructed in code.
  vfsRef?: string | null
}

// What the command tier's walk guard proves an operand's `.` and `..` with:
// the handler reaches its backend past the door, so the door's stat and link
// follow are bound around it. No dispatcher (a mount driven directly) binds
// nothing. Mirrors the Python set_walk_probe binding in Mount.run_command.
function withWalkProbe<T>(
  prefix: string,
  dispatch: DispatchFn | undefined,
  links: LinkView | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (dispatch === undefined) return fn()
  return runWithWalkProbe(prefix, { stat: dispatchStat(dispatch), follow: linkFollow(links) }, fn)
}

export class MountEntry {
  visible: (() => boolean) | null = null
  readonly mountId = uuid7()
  readonly prefix: string
  readonly vfs: BaseVFS
  // The command tier's table, built once from the VFS's functions.
  readonly io: CommandIO
  mode: MountMode
  readonly read: ReadSpec
  // `index` is this same store scoped by the cache manager, which is
  // what ops and commands receive.
  readonly indexStore: IndexCacheStore
  readonly indexConfig: IndexConfig | undefined
  readonly vfsRef: string | null
  activity = new VFSActivity()
  retiring = false
  beforeUse: (() => Promise<void>) | null = null
  private readonly readyLock = new KeyLock()

  /**
   * Per-path revision pins installed at Workspace.load time. Read
   * functions consult these via the {@link revisionFor} contextvar
   * lookup; on a hit, the backend GET pins to the recorded revision so
   * replay serves the exact bytes the agent saw. Empty during normal
   * runs; populated only by the snapshot loader.
   */
  readonly revisions = new Map<string, string>()

  cacheManager: CacheManager | null = null

  private readonly cmds = new Map<CmdKey, Command>()
  private readonly generalCmds = new Map<string, Command>()
  private readonly cmdSpecs = new Map<string, CommandSpec>()
  readonly commandLimits = new Map<string, Limit>()
  // first token -> descending token counts of multi-word command names
  // (e.g. "gws docs documents get"); backs longest-prefix command
  // resolution. null until first built; invalidated on register.
  private prefixIndex: Map<string, number[]> | null = null

  constructor(init: MountInit) {
    const prefix = init.prefix
    if (!prefix.startsWith('/')) {
      throw new Error(`prefix must start with /: ${prefix}`)
    }
    if (!prefix.endsWith('/')) {
      throw new Error(`prefix must end with /: ${prefix}`)
    }
    if (prefix.includes('//')) {
      throw new Error(`prefix must not contain //: ${prefix}`)
    }
    for (const [filetype, renderer] of Object.entries(init.vfs.renderers)) {
      if (typeof (init.vfs as unknown as Record<string, unknown>)[renderer] !== 'function') {
        throw new TypeError(
          `${init.vfs.constructor.name}.renderers maps '${filetype}' to '${renderer}', which is not a method`,
        )
      }
    }
    this.prefix = prefix
    this.vfs = init.vfs
    this.io = commandIo(init.vfs)
    this.mode = init.mode ?? MountMode.READ
    // A frozen copy carrying the coerced policy, not the caller's object.
    //
    // Frozen because Python's `ReadSpec` is a frozen dataclass, so the
    // same spec cannot be edited after the mount-time verdict passed it;
    // a plain JS object can, which would let a caller flip a RAM mount to
    // `fresh` behind the verdict's back.
    //
    // Coerced because `ReadPolicy` is a string-const object: a runtime
    // spec carrying `'FRESH'` matches no `===` downstream -- the gate, the
    // routing reconcile -- so the mount would pass its capability check
    // and then read as `bounded` everywhere, which is the silent
    // downgrade the policy exists to remove. The Python twin normalizes
    // at this same point.
    const spec = init.read ?? DEFAULT_READ_SPEC
    this.read = Object.freeze({ ...spec, policy: coerceReadPolicy(spec.policy) })
    this.indexStore = init.index ?? buildIndex(undefined, init.vfs.indexTtl)
    this.indexConfig = init.indexConfig === undefined ? undefined : { ...init.indexConfig }
    this.vfsRef = init.vfsRef ?? null
  }

  /** Whether this mount answers the op `name`. */
  answers(name: string): boolean {
    return this.callers(name, null).length > 0
  }

  /**
   * Expand glob words through the VFS's `readdir`, one pattern spec at a
   * time; a VFS with no `readdir` leaves every word as typed. The mount
   * stamps each word's mount-relative key before the walk sees it, since
   * the key is the placement's to know, and keeps the VFS retained while
   * the walk reads metadata.
   */
  async expandGlob(paths: readonly PathSpec[], prefix: string): Promise<PathSpec[]> {
    if (!this.vfs.supports('readdir')) return [...paths]
    return this.use(async () => {
      const manager = this.cacheManager
      if (manager === null) return this.runGlob(paths, prefix, this.indexStore)
      return manager.withMutation(async () => {
        await this.ensureReady()
        return this.runGlob(paths, prefix, manager.scopeIndexLocked(this.indexStore))
      })
    })
  }

  private async runGlob(
    paths: readonly PathSpec[],
    prefix: string,
    index: IndexCacheStore,
  ): Promise<PathSpec[]> {
    const out: PathSpec[] = []
    for (const p of paths) {
      const spec = prefix
        ? new PathSpec({
            virtual: p.virtual,
            directory: p.directory,
            ...(p.pattern !== null ? { pattern: p.pattern } : {}),
            resolved: p.resolved,
            vfsPath: mountKey(p.virtual, prefix),
            rawPath: p.rawPath,
          })
        : p
      out.push(...(await this.glob(spec, index)))
    }
    return out
  }

  /** Expand one pattern, keyed below the mount, through the VFS's `readdir` and `stat`. */
  glob(path: PathSpec, index?: IndexCacheStore): Promise<PathSpec[]> {
    return resolveGlobOf(this.io)(this.vfs.accessor, [path], index)
  }

  /** Metadata access bound to this mount's ownership. */
  get index(): IndexCacheStore {
    return this.cacheManager?.scopeIndex(this.indexStore) ?? this.indexStore
  }

  /** Finish deferred mount preparation before any backend or cache read. */
  async use<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureReady()
    this.checkActive()
    const release = this.activity.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  async ensureReady(): Promise<void> {
    this.checkActive()
    if (this.beforeUse === null) return
    await this.readyLock.withLock('', async () => {
      if (this.beforeUse !== null) {
        await this.beforeUse()
        this.beforeUse = null
      }
    })
    this.checkActive()
  }

  private checkActive(): void {
    if (this.retiring) throw ebusy(this.prefix)
  }

  /**
   * This mount's mode narrowed by the current session's cap. The
   * configured mode is the ceiling; a session's mode can only weaken it.
   */
  effectiveMode(): MountMode {
    return effectiveMountMode(this.prefix, this.mode)
  }

  // ── command registration ──────────────────────────

  register(cmd: Command): void {
    this.cmds.set(cmdKey(cmd.name, cmd.filetype), cmd)
    this.cmdSpecs.set(cmd.name, cmd.spec)
    this.prefixIndex = null
  }

  registerGeneral(cmd: Command): void {
    this.generalCmds.set(cmd.name, cmd)
    this.cmdSpecs.set(cmd.name, cmd.spec)
    this.prefixIndex = null
  }

  resolveCommand(cmdName: string, extension: string | null = null): Command | null {
    if (extension !== null && extension !== '') {
      const specific = this.cmds.get(cmdKey(cmdName, extension))
      if (specific !== undefined) return specific
    }
    const byVfs = this.cmds.get(cmdKey(cmdName, null))
    if (byVfs !== undefined) return byVfs
    const general = this.generalCmds.get(cmdName)
    if (general !== undefined) return general
    // Fall back to any filetype variant so callers without an extension can
    // still find the command; the actual handler is picked by runCommand.
    for (const rc of this.cmds.values()) {
      if (rc.name === cmdName) return rc
    }
    return null
  }

  /**
   * How many leading words form a registered command name here. Command
   * names may span several words ("gws docs documents get"), git-style.
   * Returns the length of the longest registered name that is a prefix of
   * `words`, or 1 (the bare first token) if no multi-word name matches; 0
   * for no words.
   */
  longestCommandMatch(words: string[]): number {
    if (words.length === 0) return 0
    if (this.prefixIndex === null) {
      const index = new Map<string, Set<number>>()
      const names = new Set<string>([
        ...this.cmdSpecs.keys(),
        ...[...this.cmds.values()].map((rc) => rc.name),
        ...this.generalCmds.keys(),
      ])
      for (const name of names) {
        const tokens = name.split(' ')
        const [first] = tokens
        if (first === undefined || tokens.length <= 1) continue
        const lengths = index.get(first) ?? new Set<number>()
        lengths.add(tokens.length)
        index.set(first, lengths)
      }
      this.prefixIndex = new Map([...index].map(([k, v]) => [k, [...v].sort((a, b) => b - a)]))
    }
    const [first] = words
    if (first === undefined) return 1
    for (const length of this.prefixIndex.get(first) ?? []) {
      if (
        length <= words.length &&
        this.resolveCommand(words.slice(0, length).join(' ')) !== null
      ) {
        return length
      }
    }
    return 1
  }

  allCommands(): readonly Command[] {
    const seen = new Set<string>()
    const out: Command[] = []
    for (const rc of this.cmds.values()) {
      if (seen.has(rc.name)) continue
      seen.add(rc.name)
      out.push(rc)
    }
    for (const rc of this.generalCmds.values()) {
      if (seen.has(rc.name)) continue
      seen.add(rc.name)
      out.push(rc)
    }
    return out
  }

  specFor(cmdName: string): CommandSpec | null {
    return this.cmdSpecs.get(cmdName) ?? null
  }

  unregister(names: string[]): void {
    for (const name of names) {
      for (const [key, rc] of this.cmds) {
        if (rc.name === name) this.cmds.delete(key)
      }
      this.generalCmds.delete(name)
      this.cmdSpecs.delete(name)
    }
  }

  commands(): Record<string, (string | null)[]> {
    const result = new Map<string, (string | null)[]>()
    for (const rc of this.cmds.values()) {
      const list = result.get(rc.name) ?? []
      list.push(rc.filetype)
      result.set(rc.name, list)
    }
    for (const name of this.generalCmds.keys()) {
      if (!result.has(name)) result.set(name, [])
    }
    return sortFiletypeMap(result)
  }

  /**
   * Whether a ranged read of `path` fetches only that range. False where
   * the read that answers it reads the whole file and slices: a VFS with no
   * native range, or a rendered filetype.
   */
  readsRanges(path: string): boolean {
    return this.vfs.readsRanges && !this.renders(getExtension(path))
  }

  /** Whether the VFS declares the function `name` a write. */
  writes(name: string): boolean {
    return callEffect(this.vfs.constructor, name) === Effect.WRITE
  }

  /**
   * Whether the VFS renders a read of `filetype`. A rendered read is never
   * served from or kept in the file cache.
   */
  renders(filetype: string | null): boolean {
    return filetype !== null && Object.hasOwn(this.vfs.renderers, filetype)
  }

  /**
   * Batch-register commands. Mirrors Python's `Mount.register_commands(...)`.
   * Commands with `vfs: null` go to the general table. Multi-VFS entries
   * (sharing the same name across mounts) are filtered to this mount's VFS
   * kind; if a name has entries but none match this mount, throw.
   */
  registerCommands(items: readonly Command[]): void {
    const kind = this.vfs.name
    interface Group {
      toRegister: Command[]
      attempted: Set<string>
    }
    const groups = new Map<string, Group>()
    for (const item of items) {
      let g = groups.get(item.name)
      if (!g) {
        g = { toRegister: [], attempted: new Set() }
        groups.set(item.name, g)
      }
      if (item.vfs === null || item.vfs === kind) g.toRegister.push(item)
      else g.attempted.add(item.vfs)
    }
    for (const [name, g] of groups) {
      if (g.toRegister.length === 0) {
        const list = [...g.attempted].sort(compareCodePoints)
        throw new Error(
          `command '${name}' is for VFS(s) [${list.map((r) => `'${r}'`).join(', ')}], not '${kind}'`,
        )
      }
    }
    for (const g of groups.values()) {
      for (const cmd of g.toRegister) {
        if (cmd.vfs === null) this.registerGeneral(cmd)
        else this.register(cmd)
      }
    }
  }

  /**
   * What answers `name` on this mount, in the order to try.
   *
   * A rendered filetype's renderer answers a read before `read` does,
   * window and all, and the first answer that is not null wins. The rest
   * is the op door's own shape around the VFS's functions: a read takes a
   * window, `append` and `pwrite` are a rewrite where the VFS only writes
   * whole files, `mkdir` refuses a taken name first, and `glob` walks
   * `readdir`. Only a method marked `@vfsCall` is reachable by name, and a
   * custom one is handed the scope and the op's positional arguments.
   * Mirrors Python's `MountEntry._callers`.
   */
  callers(name: string, filetype: string | null): OpCall[] {
    const vfs = this.vfs
    if (name === 'read') {
      const levels: OpCall[] = []
      const renderer = filetype !== null ? vfs.renderers[filetype] : undefined
      const render =
        renderer === undefined
          ? undefined
          : (vfs as unknown as Record<string, ReadFn | undefined>)[renderer]
      if (render !== undefined) {
        levels.push((scope, _args, kw) => readWindow(render.bind(vfs), true, scope, kw))
      }
      if (vfs.supports('read')) {
        levels.push((scope, _args, kw) =>
          readWindow(vfs.read.bind(vfs), vfs.readsRanges, scope, kw),
        )
      }
      return levels
    }
    if (name === 'glob') {
      return vfs.supports('readdir') ? [(scope, _args, kw) => this.glob(scope, kw.index)] : []
    }
    if ((name === 'append' || name === 'pwrite') && !vfs.supports(name)) {
      if (!vfs.supports('write')) return []
      return name === 'append'
        ? [(scope, args, kw) => this.appendByRewrite(scope, writeData(args), kw.index)]
        : [
            (scope, args, kw) =>
              this.pwriteByRewrite(scope, writeData(args), offsetArg(args[1], scope), kw.index),
          ]
    }
    if (callEffect(vfs.constructor, name) === null) return []
    if (!vfs.supports(name)) return []
    switch (name) {
      case 'readdir':
        return [(scope, _args, kw) => vfs.readdir(scope, kw.index)]
      case 'stat':
        return [(scope, _args, kw) => vfs.stat(scope, kw.index)]
      case 'write':
        return [(scope, args) => vfs.write(scope, writeData(args))]
      case 'append':
        return [(scope, args, kw) => vfs.append(scope, writeData(args), kw.index)]
      case 'pwrite':
        return [
          (scope, args, kw) =>
            vfs.pwrite(scope, writeData(args), offsetArg(args[1], scope), kw.index),
        ]
      case 'create':
        return [(scope) => vfs.create(scope)]
      case 'mkdir':
        return [(scope, _args, kw) => this.mkdir(scope, kw.parents === true)]
      case 'unlink':
        return [(scope) => vfs.unlink(scope)]
      case 'rmdir':
        return [(scope, _args, kw) => vfs.rmdir(scope, kw.index)]
      case 'rename':
        return [(scope, args) => vfs.rename(scope, dstArg(args[0]))]
      case 'truncate':
        return [(scope, args, kw) => vfs.truncate(scope, lengthArg(args[0]), kw.no_create === true)]
      case 'setattr':
        return [(scope, _args, kw) => vfs.setattr(scope, kw as SetAttrFields)]
      default: {
        const method = (vfs as unknown as Record<string, (...args: unknown[]) => unknown>)[name]
        return method === undefined ? [] : [(scope, args) => method.call(vfs, scope, ...args)]
      }
    }
  }

  private appendByRewrite(
    path: PathSpec,
    data: Uint8Array,
    index?: IndexCacheStore,
  ): Promise<void> {
    return appendByRewrite(
      (p) => this.vfs.read(p, index),
      (p, d) => this.vfs.write(p, d),
      (p) => this.vfs.stat(p, index),
      path,
      data,
    )
  }

  private pwriteByRewrite(
    path: PathSpec,
    data: Uint8Array,
    offset: number,
    index?: IndexCacheStore,
  ): Promise<void> {
    return pwriteByRewrite(
      (p) => this.vfs.read(p, index),
      (p, d) => this.vfs.write(p, d),
      (p) => this.vfs.stat(p, index),
      path,
      data,
      offset,
    )
  }

  private async mkdir(path: PathSpec, parents: boolean): Promise<void> {
    await refuseTaken((p) => this.vfs.stat(p), path, parents)
    await this.vfs.mkdir(path, parents)
  }

  /**
   * Run `name` on this mount's VFS over a scope already keyed below the
   * mount: each level in turn until one answers with something other than
   * null. A read resolves its renderer by `kwargs.filetype` when the caller
   * names one (null asks for the stored bytes) and by the path's extension
   * otherwise.
   */
  async callKeyed(
    name: string,
    scope: PathSpec,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
  ): Promise<unknown> {
    const filetype = kwargs.filetype === undefined ? getExtension(scope.virtual) : kwargs.filetype
    const levels = this.callers(name, filetype)
    if (levels.length === 0) throw enotsup(this.vfs.name, name, scope)
    for (const call of levels) {
      const result = await call(scope, args, kwargs)
      if (result !== null && result !== undefined) return result
    }
    return null
  }

  private resolveCascade<T>(
    name: string,
    extension: string | null,
    table: Map<string, T>,
    general: Map<string, T>,
  ): T[] {
    const levels: T[] = []
    if (extension !== null && extension !== '') {
      const specific = table.get(cmdKey(name, extension))
      if (specific !== undefined) levels.push(specific)
    }
    const byVfs = table.get(cmdKey(name, null))
    if (byVfs !== undefined) levels.push(byVfs)
    const generalEntry = general.get(name)
    if (generalEntry !== undefined) levels.push(generalEntry)
    return levels
  }

  // ── execution ─────────────────────────────────────

  async runCommand(
    cmdName: string,
    paths: PathSpec[],
    texts: string[],
    flags: Record<string, FlagValue>,
    context: ExecContext = {},
  ): Promise<[ByteSource | null, IOResult]> {
    return this.use(async (): Promise<[ByteSource | null, IOResult]> => {
      const handlers = await this.pickHandlers(cmdName, paths, context)
      if (handlers.length === 0) {
        return [
          null,
          new IOResult({
            exitCode: 127,
            stderr: encodeText(`${cmdName}: command not found`),
          }),
        ]
      }
      const keyedPaths = this.keyedPaths(cmdName, paths)
      const cmdOpts = this.commandOpts(cmdName, this.keyedFlags(flags), context)
      return this.inCommandScope(context, async (): Promise<[ByteSource | null, IOResult]> => {
        for (const cmd of handlers) {
          const refusal = this.readOnlyRefusal(cmdName, cmd, flags)
          if (refusal !== null) return [null, refusal]
          const result = await this.runHandler(cmdName, cmd, keyedPaths, texts, cmdOpts, context)
          if (result !== null) return this.wrapOutput(cmdName, cmd, keyedPaths, result)
        }
        return [null, new IOResult()]
      })
    })
  }

  /**
   * The handlers to try in order.
   *
   * A filetype handler is selected from the operand's NAME, and a
   * directory can carry any extension, so the cascade would hand a
   * renderer a directory to read. One stat settles it, and only when a
   * handler for this exact extension exists, so a mount with no filetype
   * registrations never reaches the probe. The built-in is what a
   * directory should get: it owns GNU's `Is a directory` wording, and the
   * renderer owns nothing but its own format. The DISPATCHER's stat, not
   * the backend's, so a mount root and a namespace-only directory answer
   * too; null means neither plane saw anything, in which case the renderer
   * reports its own miss. Mirrors Python's MountEntry._pick_handlers.
   */
  private async pickHandlers(
    cmdName: string,
    paths: PathSpec[],
    context: ExecContext,
  ): Promise<Command[]> {
    let extension =
      paths.length > 0 && paths[0] !== undefined ? getExtension(paths[0].virtual) : null
    const first = paths[0]
    if (
      extension !== null &&
      extension !== '' &&
      first !== undefined &&
      context.statPath !== undefined &&
      this.cmds.has(cmdKey(cmdName, extension))
    ) {
      const entry = await context.statPath(first)
      if (entry !== null && entry.type === FileType.DIRECTORY) extension = null
    }
    return this.resolveCascade(cmdName, extension, this.cmds, this.generalCmds)
  }

  /** `p` with this mount's backend key stamped on. */
  private keyed(p: PathSpec): PathSpec {
    return new PathSpec({
      virtual: p.virtual,
      directory: p.directory,
      pattern: p.pattern,
      resolved: p.resolved,
      vfsPath: mountKey(p.virtual, rstripSlash(this.prefix)),
      rawPath: p.rawPath,
      dotted: p.dotted,
      walkError: p.walkError,
    })
  }

  /**
   * Stamp this mount's backend key onto each path operand. A stdin `-`
   * routed nowhere, so it rides on whichever mount runs the line, beside
   * the operands that chose it. Mirrors Python's MountEntry._keyed_paths.
   */
  private keyedPaths(cmdName: string, paths: PathSpec[]): PathSpec[] {
    const mountPrefix = rstripSlash(this.prefix)
    const stdinSlots = STDIN_DASH_COMMANDS.has(cmdName)
      ? (STDIN_DASH_LEADING.get(cmdName) ?? paths.length)
      : 0
    return paths.map((p, index) =>
      index < stdinSlots && p.rawPath === '-'
        ? new PathSpec({
            virtual: `${mountPrefix}/-`,
            directory: p.directory,
            resolved: p.resolved,
            vfsPath: '-',
            rawPath: p.rawPath,
          })
        : this.keyed(p),
    )
  }

  /**
   * Stamp this mount's backend key onto path-shaped flag values so backend
   * reads can address them: a single PathSpec (awk -f, tar -f) or a list
   * (repeated grep -f, jq's --rawfile pairs). Everything else passes
   * through unchanged. Mirrors Python's MountEntry._keyed_flags.
   */
  private keyedFlags(flags: Record<string, FlagValue>): Record<string, FlagValue> {
    const stampedFlags: Record<string, FlagValue> = { ...flags }
    flagOccurrences(stampedFlags).push(...flagOccurrences(flags))
    for (const [key, value] of Object.entries(flags)) {
      if (value instanceof PathSpec) stampedFlags[key] = this.keyed(value)
      else if (Array.isArray(value) && value.some((item) => item instanceof PathSpec)) {
        const items: readonly (string | PathSpec)[] = value
        stampedFlags[key] = items.map((item) =>
          item instanceof PathSpec ? this.keyed(item) : item,
        )
      }
    }
    return stampedFlags
  }

  /**
   * The one typed bag a handler reads, built here and nowhere else.
   *
   * A pattern operand travels to the handler whole. The handler resolves it
   * once, through the shared adapter, which is where the namespace facts
   * (links, nested mount roots, a trailing slash) are in view; the VFS's
   * glob hook serves the shell tier and cannot see them, so expanding here
   * would lose what the handler needs. Python's dispatcher never expands
   * either. Mirrors Python's MountEntry._command_opts.
   */
  private commandOpts(
    cmdName: string,
    flags: Record<string, FlagValue>,
    context: ExecContext,
  ): CommandOpts {
    return {
      stdin: context.stdin ?? null,
      flags,
      mountPrefix: rstripSlash(this.prefix),
      command: cmdName,
      cwd: context.cwd ?? ROOT_CWD,
      index: this.index,
      io: this.io,
      ...(context.dispatch !== undefined ? { dispatch: context.dispatch } : {}),
      ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
      ...(context.env !== undefined ? { env: context.env } : {}),
      ...(context.sessionView !== undefined ? { sessionView: context.sessionView } : {}),
      ...(context.processes !== undefined ? { processes: context.processes } : {}),
      ...(context.execAllowed !== undefined ? { execAllowed: context.execAllowed } : {}),
      ...(context.execPathAllowed !== undefined
        ? { execPathAllowed: context.execPathAllowed }
        : {}),
      ...(context.runtime !== undefined ? { runtime: context.runtime } : {}),
      ...(context.ns !== undefined ? { ns: context.ns } : {}),
      ...(context.statPath !== undefined ? { statPath: context.statPath } : {}),
      ...(context.readdirPath !== undefined ? { readdirPath: context.readdirPath } : {}),
      ...(context.shell !== undefined ? { shell: context.shell } : {}),
      ...(context.argv !== undefined ? { argv: context.argv } : {}),
    }
  }

  /**
   * Run `fn` with what a handler's backend calls read bound: the mode the
   * command tier's mode guard holds each write to (its own region's mode),
   * what the command tier's walk guard proves an operand's `.` and `..`
   * with, the recorder's mount, the mount's cache manager and the snapshot
   * revision pins. Mirrors Python's MountEntry._command_scope.
   */
  private inCommandScope<T>(context: ExecContext, fn: () => Promise<T>): Promise<T> {
    return runWithMountGate(this.prefix, this.mode, () =>
      withWalkProbe(this.prefix, context.dispatch, context.ns?.links, () =>
        runWithMountContext(
          () =>
            runWithCacheManager(this.cacheManager, () =>
              runWithRevisions(this.revisions.size > 0 ? this.revisions : null, fn),
            ),
          this.mountId,
        ),
      ),
    )
  }

  /**
   * Refuse a write command no door would see, on a read-only mount.
   *
   * A command whose I/O runs under the path guards is refused where it
   * writes, because only the write knows whether a line writes: `gzip -c`,
   * `tar -t` and `split -n 1/2` read a read-only mount like any reader, and
   * `gzip f` is refused at the write of `f.gz`, in gzip's own GNU voice. A
   * write command that reaches its service some other way (trello's
   * id-addressed card writes, a custom backend's own verb) is refused here,
   * before it runs, because no door would see its write. strongestModeUnder,
   * not effectiveMode: a mount whose only writable region is a show entry
   * still runs it. Only wrapper-owned responses (help, an injected version)
   * bypass it. The trailing newline is load-bearing: stderr accumulates
   * across a line. Mirrors Python's MountEntry._read_only_refusal.
   */
  private readOnlyRefusal(
    cmdName: string,
    cmd: Command,
    flags: Record<string, FlagValue>,
  ): IOResult | null {
    const infoOnly = flags.help === true || (flags.version === true && hasInjectedVersion(cmd.spec))
    if (
      cmd.write &&
      !cmd.pathGuarded &&
      !infoOnly &&
      strongestModeUnder(this.prefix, this.mode) === MountMode.READ
    ) {
      return new IOResult({
        exitCode: 1,
        stderr: encodeText(`${cmdName}: read-only mount at ${this.prefix}\n`),
      })
    }
    return null
  }

  /**
   * Run one handler under the mount-resolved timeout.
   *
   * The dispatch-level guard only sees default limits (the mount is unknown
   * before routing), so the mount-resolved timeout must also bound the
   * command body: eager commands do their work inside cmd.fn, where the
   * stream-consumption guard never runs. limitOverride is the caller's
   * profile, mount and workspace entry; a null one is "no opinion" and must
   * not shadow this mount's own table. runWithTimeout abandons the promise,
   * it cannot cancel it; the aborted signal lets a runtime kill what it
   * spawned (python cancels the task instead). The ambient context.signal
   * is a background job's kill channel, folded into the same wire.
   * timeoutSeconds rides along so an engine that executes on the event loop
   * (quickjs) can interrupt itself when the timer cannot fire. Mirrors
   * Python's MountEntry._run_handler.
   */
  private async runHandler(
    cmdName: string,
    cmd: Command,
    paths: PathSpec[],
    texts: string[],
    cmdOpts: CommandOpts,
    context: ExecContext,
  ): Promise<CommandFnResult> {
    const resolvedLimit = resolveLimit(
      cmdName,
      [],
      cmd.limit,
      context.limitOverride ?? this.commandLimits.get(cmdName) ?? null,
    )
    const cmdTimeout = resolvedLimit !== null ? resolvedLimit.timeoutSeconds : null
    const guard = cmdTimeout !== null && cmdTimeout > 0 ? new AbortController() : null
    const runSignal = mergeSignals(guard?.signal, context.signal)
    const runOpts =
      runSignal !== undefined
        ? {
            ...cmdOpts,
            signal: runSignal,
            ...(cmdTimeout !== null && cmdTimeout > 0 ? { timeoutSeconds: cmdTimeout } : {}),
          }
        : cmdOpts
    try {
      return await runWithTimeout(
        Promise.resolve(cmd.fn(this.vfs.accessor, paths, texts, runOpts)),
        cmdTimeout,
        cmdName,
      )
    } catch (err) {
      if (guard !== null && err instanceof CommandTimeoutError) guard.abort()
      throw err
    }
  }

  /** Frame a handler's answer as this mount's command output. Mirrors
   * Python's MountEntry._wrap_output. */
  private wrapOutput(
    cmdName: string,
    cmd: Command,
    paths: PathSpec[],
    result: NonNullable<CommandFnResult>,
  ): [ByteSource | null, IOResult] {
    result[1].producer = {
      command: cmdName,
      prefixes: [this.prefix],
      declared: cmd.limit ?? null,
    }
    const [stdout, io] = wrapMountStreams(result, this.mountId, this.activity)
    return [
      stdout !== null && !(stdout instanceof Uint8Array)
        ? commandOutput(stdout, io, cmdName, paths)
        : stdout,
      io,
    ]
  }

  /**
   * Run an op on this mount's VFS. A read tries a rendered filetype's
   * renderer first, then the VFS's own function; the first answer that is
   * not null wins. A caller may name the filetype, and null asks for the
   * stored bytes even where the VFS renders the filetype: a
   * read-modify-write hands whatever it read straight back to `write`,
   * which always stores, so reading a rendered form would store the
   * rendering over the file. Mirrors Python's `MountEntry.call`.
   */
  async call(
    name: string,
    path: string,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
  ): Promise<unknown> {
    return this.use(async (): Promise<unknown> => {
      const filetype = kwargs.filetype === undefined ? getExtension(path) : kwargs.filetype
      const levels = this.callers(name, filetype)
      if (levels.length === 0) {
        throw enotsup(this.vfs.name, name, path)
      }
      if (this.writes(name)) {
        const dst = kwargs.dst
        const endpoints = [PathSpec.fromStrPath(path)]
        if (dst instanceof PathSpec) endpoints.push(dst)
        requirePathsWritable(endpoints, this.prefix, this.mode, SUBTREE_OPS.has(name))
      }
      const mountPrefix = rstripSlash(this.prefix)
      const lastSlash = path.lastIndexOf('/')
      const scope = new PathSpec({
        virtual: path,
        directory: lastSlash > 0 ? path.slice(0, lastSlash + 1) : '/',
        vfsPath: mountKey(path, mountPrefix),
      })
      const effectiveKwargs: OpKwargs = {
        ...kwargs,
        ...(kwargs.index === undefined ? { index: this.index } : {}),
      }
      // Per-op caps are policy and fire at the op door (postVfs); only
      // the timeout stays here, bounding the backend call itself.
      const opOverride = this.commandLimits.get(name) ?? null
      const opTimeout = opOverride !== null ? opOverride.timeoutSeconds : null
      return runWithMountContext(
        () =>
          runWithRevisions(this.revisions.size > 0 ? this.revisions : null, async () => {
            for (const call of levels) {
              const result = await runWithTimeout(
                Promise.resolve(call(scope, args, effectiveKwargs)),
                opTimeout,
                name,
              )
              if (result !== null && result !== undefined) {
                return wrapStream(result, this.mountId, this.activity)
              }
            }
            return null
          }),
        this.mountId,
      )
    })
  }
}

async function* commandOutput(
  source: AsyncIterable<Uint8Array>,
  io: IOResult,
  command: string,
  paths: PathSpec[],
): AsyncIterable<Uint8Array> {
  try {
    yield* source
  } catch (err) {
    if (err instanceof CommandTimeoutError || (err instanceof Error && err.name === 'AbortError'))
      throw err
    const existing = await materialize(io.stderr)
    const message = formatFsError(command, err, paths)
    const stderr = new Uint8Array(existing.length + message.length)
    stderr.set(existing)
    stderr.set(message, existing.length)
    io.stderr = stderr
    io.exitCode = err instanceof UsageError ? err.exitCode : readFailExitCode(command, err)
  }
}

/** Preserve a streaming operation's recording owner after its dispatch frame exits. */
export function wrapStream(result: unknown, mountId: string, activity: VFSActivity): unknown {
  if (result instanceof CachableAsyncIterator) {
    result.wrapSource((source) => withMountContext(source, mountId))
    return activity.hold(result)
  }
  if (result !== null && typeof result === 'object' && Symbol.asyncIterator in result) {
    return activity.hold(withMountContext(result as AsyncIterable<Uint8Array>, mountId))
  }
  return result
}

// Push `mountId` back during lazy consumption of anything the command
// handed back, so a deferred backend read attributes its record the same
// way an eager one does. Dedup by identity: a stream that appears both as the
// primary stdout and in IOResult.reads/writes is wrapped once.
// Mirrors python's _wrap_mount_streams.
function wrapMountStreams(
  result: [ByteSource | null, IOResult],
  mountId: string,
  activity: VFSActivity,
): [ByteSource | null, IOResult] {
  const [stream, io] = result
  const seen = new Map<ByteSource, ByteSource>()
  const scope = new ContextScope([
    ...captureSessionContext(),
    ...captureOpPolicies(),
    ...captureRecordingContext(),
    captureCacheContext(),
    captureCommandScope(),
  ])
  const wrap = (obj: ByteSource): ByteSource => {
    if (obj instanceof Uint8Array) return obj
    const hit = seen.get(obj)
    if (hit !== undefined) return hit
    let wrapped: ByteSource
    if (obj instanceof CachableAsyncIterator) {
      obj.wrapSource((src) => scope.stream(withMountContext(src, mountId)))
      wrapped = obj
    } else {
      wrapped = scope.stream(withMountContext(obj, mountId))
    }
    wrapped = activity.hold(wrapped)
    seen.set(obj, wrapped)
    return wrapped
  }
  for (const [k, v] of Object.entries(io.reads)) io.reads[k] = wrap(v)
  for (const [k, v] of Object.entries(io.writes)) io.writes[k] = wrap(v)
  return [stream !== null ? wrap(stream) : null, io]
}

function sortFiletypeMap(m: Map<string, (string | null)[]>): Record<string, (string | null)[]> {
  const out: Record<string, (string | null)[]> = {}
  for (const k of [...m.keys()].sort(compareCodePoints)) {
    const list = m.get(k) ?? []
    list.sort((a, b) => {
      const aKey = a === null ? 0 : 1
      const bKey = b === null ? 0 : 1
      if (aKey !== bKey) return aKey - bKey
      const as = a ?? ''
      const bs = b ?? ''
      return compareCodePoints(as, bs)
    })
    out[k] = list
  }
  return out
}
