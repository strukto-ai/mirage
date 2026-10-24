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

import { DevVFS } from '../../vfs/dev/dev.ts'
import { HistoryViewVFS } from '../../vfs/history/history.ts'
import { RAMAccessor } from '../../accessor/ram.ts'
import { activePipe, pipeBelow } from '../../core/dev/device.ts'
import type { DevicePipe } from '../../core/dev/pipe.ts'
import { norm } from '../../utils/path.ts'
import {
  type Caller,
  currentCaller,
  effectiveMountMode,
  requirePathsWritable,
  runWithCaller,
  strongestModeUnder,
  withCaller,
} from '../../context/session_context.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { coerceReadPolicy } from './read_policy.ts'
import { coerceWritePolicy, writeConditions } from './write_policy.ts'
import { KeyLock } from '../../cache/lock.ts'
import { type IndexConfig, LookupStatus } from '../../cache/index/config.ts'
import { buildIndex } from '../../cache/index/factory.ts'
import { indexLock } from '../../cache/index/lock.ts'
import { ListingCheckStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { Command, type CommandFnResult, type Context } from '../../commands/config.ts'
import { STDIN_DASH_COMMANDS, STDIN_DASH_LEADING } from '../../commands/spec/constants.ts'
import { hasInjectedHelp, hasInjectedVersion } from '../../commands/spec/standard.ts'
import { ROOT_CWD } from '../../commands/constants.ts'
import type { OpKwargs, SessionAccess } from '../../view/types.ts'
import {
  appendByRewrite,
  expectOffset,
  pwriteByRewrite,
  truncateByRewrite,
  refuseTaken,
} from '../../core/generic/rewrite.ts'
import { declared, declaredCalls, methodName } from '../../vfs/call.ts'
import { WRITE_EFFECTS } from '../../vfs/constants.ts'
import { Effect, type Handed } from '../../vfs/types.ts'
import { isUnsatisfiableRange, sliceWindow } from '../../utils/ranges.ts'

import { getExtension } from '../../utils/filetype.ts'
import { resolveLimit } from '../../policy/index.ts'
import { runWithTimeout, withPullTimeout } from '../../commands/builtin/utils/limit.ts'
import { materialize, type ByteSource, IOResult } from '../../io/types.ts'
import { closeQuietly } from '../../io/stream.ts'
import { flagOccurrences } from '../../commands/spec/flag_view.ts'
import { CommandSpec, type CommandSpecInit, type FlagValue } from '../../commands/spec/types.ts'
import { publishRead, runWithWriteContext } from '../../cache/context.ts'
import { latestFingerprint } from '../../cache/file/io.ts'
import type { OpRecord } from '../../observe/record.ts'
import { type WriteContext } from '../../cache/types.ts'
import type { CacheManager } from '../../cache/manager.ts'
import { mergeSignals } from '../../utils/abort.ts'
import {
  answered,
  cliVoice,
  mountVoice,
  runHandler,
  type HandlerVoice,
} from '../executor/command/handler.ts'
import { CLI, type CLIHandler, noopAccessor } from '../../commands/cli/types.ts'
import { callerSignal } from '../../context/session_context.ts'
import {
  activeRecords,
  commandRecords,
  runWithMountContext,
  runWithRecording,
  runWithRevisions,
  withMountContext,
} from '../../observe/context.ts'
import { type IdSource, SystemIdSource } from '../../utils/ids.ts'
import { Activity } from '../../utils/activity.ts'
import type { BaseVFS } from '../../vfs/base.ts'
import type { Accessor } from '../../accessor/base.ts'
import type { DirListing } from '../../types.ts'
import {
  type Limit,
  type Producer,
  type ReadSpec,
  type SearchQuery,
  type SetAttrFields,
  type WalkProbe,
  DEFAULT_READ_SPEC,
  FileChangeKind,
  FileStat,
  WritePolicy,
  FileType,
  ListingVersion,
  MountMode,
  PathSpec,
  ReadPolicy,
} from '../../types.ts'
import { ebusy, enotdir, enotsup, isEnoent } from '../../errors/fs.ts'
import { HANDED, STORED_OPS } from './constants.ts'
import {
  beyondWindow,
  entryAt,
  folderOf,
  indexKey,
  keepListing,
  keepTree,
  storedListing,
  storedStat,
  storedTree,
  unprovenMiss,
} from './listing.ts'
import { rstripSlash } from '../../utils/slash.ts'
import {
  dispatchStat,
  linkFollow,
  vfsStatPath,
  virtualFlags,
  virtualKey,
} from '../../commands/builtin/utils/paths.ts'
import { linkView } from '../../commands/builtin/utils/links.ts'
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
  handed?: Handed,
  offset?: number,
  size?: number | null,
) => Promise<ByteSource> | AsyncIterable<Uint8Array>

function cmdKey(name: string, filetype: string | null): CmdKey {
  return `${name}\u0000${filetype ?? ''}`
}

function writeData(args: readonly unknown[]): Uint8Array {
  const first = args[0]
  if (first instanceof Uint8Array) return first
  throw new TypeError('write op requires a Uint8Array as the first arg')
}

function writeSource(args: readonly unknown[]): ByteSource {
  const first = args[0]
  if (first instanceof Uint8Array) return first
  if (
    first !== null &&
    typeof first === 'object' &&
    Symbol.asyncIterator in first &&
    typeof first[Symbol.asyncIterator] === 'function'
  )
    return first as AsyncIterable<Uint8Array>
  throw new TypeError('write op requires bytes or an async byte source as the first arg')
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

/** What rides beside the path: the handed stats, and a walk's `limit`. */
function handedOf(kw: OpKwargs): Handed | undefined {
  const handed = kw.handed as Handed | undefined
  return typeof kw.limit === 'number' ? { ...handed, limit: kw.limit } : handed
}

/**
 * Refuse a keyword the function `name` does not take: the TypeError a direct
 * call raises in Python, never silently dropped. The mount hands every
 * function its `index` and a caller may name the `filetype`; a built-in takes
 * the keywords its Python signature names, and a custom function none, a
 * TypeScript function having no keyword parameters. Mirrors Python's `_taken`.
 */
function taken(name: string, kwargs: OpKwargs): void {
  const keywords: Readonly<Record<string, readonly string[]>> = {
    readdir: ['limit'],
    read_tree: ['limit'],
    read: ['offset', 'size'],
    write: ['atomic'],
    mkdir: ['parents'],
    truncate: ['no_create'],
    files_containing: ['whole_word', 'ignore_case'],
    lines_containing: ['ignore_case'],
    before_full_walk: ['files'],
    setattr: ['mode', 'uid', 'gid', 'atime', 'mtime'],
  }
  const known = Object.hasOwn(keywords, name) ? (keywords[name] ?? []) : []
  const [first] = Object.keys(kwargs)
    .filter(
      (key) =>
        key !== 'index' && key !== 'filetype' && !known.includes(key) && kwargs[key] !== undefined,
    )
    .sort(compareCodePoints)
  if (first !== undefined) {
    throw new TypeError(`${name}() got an unexpected keyword argument '${first}'`)
  }
}

/**
 * A backend read's answer as a stream: a promise awaited on the first pull,
 * a stream passed through, bytes as one chunk. Mirrors Python's `_as_stream`.
 */
async function* asStream(
  answer: Promise<ByteSource> | AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const found = await answer
  if (found instanceof Uint8Array) {
    if (found.byteLength > 0) yield found
    return
  }
  yield* found
}

/**
 * A backend read's answer as bytes, a stream collected. A whole read's
 * stream publishes the version it recorded for the bytes collected from it,
 * as a whole read answering bytes publishes its own, so a read-modify-write
 * still sends the version it read. Its records are its own, so a read
 * running beside it never lends it a version, and reach the block around it
 * too, so the write a rewrite makes still sees the read that proves the copy
 * it extends. Mirrors Python's `_collected`.
 */
async function collected(
  answer: Promise<ByteSource> | AsyncIterable<Uint8Array>,
  path: PathSpec,
  whole: boolean,
): Promise<Uint8Array> {
  const found = await answer
  if (found instanceof Uint8Array) return found
  if (!whole) return materialize(found)
  const held = currentCaller().commandSink
  const outer = held !== null && held[1] !== held[0] ? held[1] : null
  const collect = (): Promise<readonly [Uint8Array, OpRecord[]]> =>
    commandRecords(async (records) => {
      try {
        return [await materialize(found), records] as const
      } finally {
        outer?.push(...records)
      }
    })
  const [data, records] =
    activeRecords() === undefined ? (await runWithRecording(collect))[0] : await collect()
  publishRead(path.virtual, data, latestFingerprint(records, path.virtual))
  return data
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
  handed: Handed | undefined,
): Promise<Uint8Array> {
  const offset = typeof kwargs.offset === 'number' ? kwargs.offset : 0
  const size = typeof kwargs.size === 'number' ? kwargs.size : null
  if (size === 0) return new Uint8Array(0)
  const whole = offset === 0 && size === null
  if (ranges && !whole) {
    try {
      return await collected(read(path, handed, offset, size), path, false)
    } catch (err) {
      if (!isUnsatisfiableRange(err)) throw err
      return new Uint8Array(0)
    }
  }
  const data = await collected(read(path, handed), path, true)
  return whole ? data : sliceWindow(data, offset, size)
}

export interface MountInit {
  prefix: string
  vfs: BaseVFS
  mode?: MountMode
  /** How this mount's cached bytes are revalidated. */
  read?: ReadSpec
  /** Whether this mount's writes carry the version they were based on. */
  write?: WritePolicy
  // The store this mount runs its driver under; the registry builds
  // one, shared with any alias of the same instance. A bare entry gets
  // a RAM store at the driver's TTL.
  index?: IndexCacheStore
  indexConfig?: IndexConfig | undefined
  // The `vfs:` value the driver was built from, recorded for snapshots;
  // null for one constructed in code.
  vfsRef?: string | null
  /** Where the mount's id is drawn; omitted means the system source. */
  ids?: IdSource
}

// What the walk guard proves an operand's `.` and `..` with: the
// dispatcher's stat and link follow, bound around the handler. No session
// files (a mount driven directly) binds nothing. Mirrors the Python
// set_walk_probe binding in Mount.run_command.
function walkProbeOf(ctx: Partial<Context>): WalkProbe | null {
  if (ctx.vfs === undefined) return null
  return { stat: dispatchStat(ctx.vfs.dispatch), follow: linkFollow(linkView(ctx.vfs)) }
}

/**
 * A command tree's root, which never runs: the executor walks the tree and
 * runs the leaf the line names (`MountEntry.runLeaf`). Mirrors Python's
 * `_tree_root`.
 */
function treeRoot(
  _accessor: Accessor,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): CommandFnResult {
  throw new Error(`${ctx.spec?.name ?? '?'}: a command tree runs the leaf its walk names`)
}

/**
 * The command a mount registers for a command tree: its root, under the
 * tree's name. The tree runs on the mount's accessor, so it declares none of
 * an installation's own: no config, no accessor, no script, no runtime.
 * Mirrors Python's `_tree_command`.
 */
function treeCommand(cli: CLI): Command {
  const name = cli.spec.name
  for (const [setting, own] of [
    ['configModel', cli.configModel !== null],
    ['accessor', cli.accessor !== noopAccessor],
    ['script', cli.script !== null],
    ['runtime', cli.runtime !== null],
  ] as const) {
    if (own) {
      throw new Error(
        `cli '${name}': a command tree on a mount runs on the mount's accessor; it cannot declare ${setting}`,
      )
    }
  }
  return new Command({
    name,
    spec: cli.spec,
    vfs: null,
    filetype: null,
    fn: treeRoot,
    write: Object.values(cli.handlers).some((handler) => handler.write),
  })
}

// The grammar a handler sees at `ctx.spec`, named for the command it runs as
// (python3 or python, js or node). Mirrors Python's _named_spec.
function namedSpec(cmd: Command, cmdName: string): CommandSpec {
  if (cmd.spec.name === cmdName) return cmd.spec
  const spec: CommandSpecInit = cmd.spec
  return new CommandSpec({ ...spec, name: cmdName })
}

export class MountEntry {
  visible: ((sessionId: string | null) => boolean) | null = null
  readonly mountId: string
  readonly prefix: string
  readonly vfs: BaseVFS
  // The functions the VFS answers itself, read once when it is mounted: each
  // dispatcher call it defines, and `read_range` when a read fetches only the
  // range asked for. A command asks its mount's row (`MountView.answers`).
  readonly calls: ReadonlySet<string>
  mode: MountMode
  readonly read: ReadSpec
  readonly write: WritePolicy
  // `index` is this same store scoped by the cache manager, which is
  // what ops and commands receive.
  readonly indexStore: IndexCacheStore
  readonly indexConfig: IndexConfig | undefined
  readonly vfsRef: string | null
  activity = new Activity()
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
  private writeContextFor: { manager: CacheManager; context: WriteContext } | null = null

  private readonly cmds = new Map<CmdKey, Command>()
  // The keys of `cmds` a user registered (`registerCommands`), not mirage.
  private readonly userKeys = new Set<CmdKey>()
  private readonly generalCmds = new Map<string, Command>()
  // name -> the root command registered and the tree it walks
  private readonly trees = new Map<string, [Command, CLI]>()
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
    this.mountId = (init.ids ?? new SystemIdSource()).uuid7()
    this.prefix = prefix
    this.vfs = init.vfs
    const vfs = init.vfs
    const calls = new Set(
      [...declaredCalls(vfs.constructor as { prototype: unknown }).keys()].filter((name) =>
        vfs.supports(name),
      ),
    )
    if (vfs.readsRanges) calls.add('read_range')
    this.calls = calls
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
    // operand probe -- so the mount would pass its capability check
    // and then read as `bounded` everywhere, which is the silent
    // downgrade the policy exists to remove. The Python twin normalizes
    // at this same point.
    const spec = init.read ?? DEFAULT_READ_SPEC
    this.read = Object.freeze({ ...spec, policy: coerceReadPolicy(spec.policy) })
    // What the client keeps of its own (a store's search results) is served
    // under the same policy.
    init.vfs.accessor.govern?.(this.read)
    // Coerced so an untyped caller's bare string still matches `===`.
    this.write = coerceWritePolicy(init.write)
    this.indexStore = init.index ?? buildIndex(undefined, init.vfs.indexTtl)
    this.indexConfig = init.indexConfig === undefined ? undefined : { ...init.indexConfig }
    this.vfsRef = init.vfsRef ?? null
  }

  /** Whether this mount answers the op `name`. */
  answers(name: string): boolean {
    return this.callers(name, null).length > 0
  }

  /**
   * The VFS as the owner of `access` sees it: the device mount's view of that
   * session's descriptors, or the history view of its commands, which a
   * browser call cannot find any other way.
   */
  private viewFor(access?: SessionAccess): BaseVFS {
    if (access === undefined) return this.vfs
    if (this.vfs instanceof DevVFS || this.vfs instanceof HistoryViewVFS) {
      return this.vfs.forSession(access.sessionId)
    }
    return this.vfs
  }

  /** The live pipe a read of `path` takes bytes from, which another task is still writing. Mirrors Python's `live_pipe`. */
  livePipe(path: string, access?: SessionAccess): DevicePipe | null {
    const accessor = this.viewFor(access).accessor
    if (!(accessor instanceof RAMAccessor)) return null
    return activePipe(accessor, norm('/' + mountKey(path, rstripSlash(this.prefix))))
  }

  /** Whether a live pipe sits at `path` or below it. Mirrors Python's `holds_live_pipe`. */
  holdsLivePipe(path: string, access?: SessionAccess): boolean {
    const accessor = this.viewFor(access).accessor
    if (!(accessor instanceof RAMAccessor)) return false
    return pipeBelow(accessor, norm('/' + mountKey(path, rstripSlash(this.prefix))))
  }

  /** Metadata access bound to this mount's ownership. */
  get index(): IndexCacheStore {
    return this.cacheManager?.scopeIndex() ?? this.indexStore
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
   * This mount's mode narrowed by the owner's cap, or the live sessions'
   * when no owner is supplied. The configured mode is the ceiling; a
   * session's mode can only weaken it.
   */
  effectiveMode(access?: SessionAccess): MountMode {
    return effectiveMountMode(this.prefix, this.mode, access)
  }

  // ── command registration ──────────────────────────

  register(cmd: Command): void {
    const key = cmdKey(cmd.name, cmd.filetype)
    this.cmds.set(key, cmd)
    this.userKeys.add(key)
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
   * Whether a run of `cmdName` on an operand with `extension` can reach a
   * handler that declares it may write. Every handler the run's cascade tries
   * counts, the filetype one first, since one that declines hands the run to
   * the next. The directory probe a run makes (`pickHandlers`) is not made,
   * so a directory named like a file counts its filetype handler too.
   * `builtins` is false when the line's options leave mirage's own handlers
   * nothing to write (`changesFiles`); a user command counts either way.
   * Mirrors Python's MountEntry.may_write.
   */
  mayWrite(cmdName: string, extension: string | null = null, builtins = true): boolean {
    return this.resolveCascade(cmdName, extension, this.cmds, this.generalCmds).some(
      (cmd) => cmd.write && (builtins || this.isUserCommand(cmd)),
    )
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
  /**
   * Refuse a write the mount's mode no longer grants at any path. Admission
   * judged the mode before the call waited for the mount and for its write
   * lock; `setMountMode` can make the mount read-only in between, so the mode
   * is read again as the backend call starts. A call that reaches a subtree
   * (a rename, a tree removal or copy) is refused by a read-only region
   * anywhere below its paths, and a copy only reads its source. Mirrors
   * Python's `require_writable`.
   */
  requireWritable(
    name: string,
    path: PathSpec,
    values: readonly unknown[],
    access?: SessionAccess,
  ): void {
    const mark = declared(this.vfs.constructor, name)
    if (mark === null || !WRITE_EFFECTS.includes(mark.effect)) return
    const others = values.filter((value): value is PathSpec => value instanceof PathSpec)
    requirePathsWritable(
      mark.effect === Effect.COPY ? others : [path, ...others],
      this.prefix,
      this.mode,
      mark.subtree,
      access,
    )
  }

  /** Refuse a keyword `name` does not take, as a cold call would. Mirrors Python's `refuse_keywords`. */
  refuseKeywords(name: string, kwargs: OpKwargs): void {
    taken(name, kwargs)
  }

  /**
   * Whether the VFS renders a read of `filetype`. A rendered read is never
   * served from or kept in the file cache.
   */
  renders(filetype: string | null): boolean {
    return filetype !== null && Object.hasOwn(this.vfs.renderers, filetype)
  }

  /**
   * Batch-register user commands. Mirrors Python's `Mount.register_commands(...)`.
   * Each one is this mount's own, keyed by name and filetype, so it wins
   * over the shared commands of that name, and is a user command
   * (`isUserCommand`): refused before it writes to a read-only one. Multi-VFS entries are filtered as
   * `ownCommands` says. A `CLI` serves its verbs as a command tree on this
   * mount, under its root's name: a line naming it walks the tree as an
   * installed CLI's does and runs the leaf on this mount's accessor
   * (`runLeaf`); a tree that declares an installation's own setting throws.
   */
  registerCommands(items: readonly (Command | CLI)[]): void {
    const [commands, trees] = this.ownCommands(items)
    for (const cmd of commands) this.register(cmd)
    for (const [root, cli] of trees) this.trees.set(root.name, [root, cli])
  }

  /**
   * Register mirage's own commands for this mount's VFS (a builtin backend's
   * table), filtered as `registerCommands` filters; they are not user
   * commands. Mirrors Python's `Mount._register_builtins`.
   */
  registerBuiltinCommands(items: readonly Command[]): void {
    for (const cmd of this.ownCommands(items)[0]) {
      const key = cmdKey(cmd.name, cmd.filetype)
      this.cmds.set(key, cmd)
      this.userKeys.delete(key)
      this.cmdSpecs.set(cmd.name, cmd.spec)
      this.prefixIndex = null
    }
  }

  /**
   * The entries of `items` this mount registers: multi-VFS entries (sharing
   * the same name across mounts) are filtered to this mount's VFS kind; if a
   * name has entries but none match this mount, throw.
   */
  private ownCommands(items: readonly (Command | CLI)[]): [Command[], [Command, CLI][]] {
    const kind = this.vfs.name
    interface Group {
      toRegister: Command[]
      attempted: Set<string>
    }
    const groups = new Map<string, Group>()
    const trees: [Command, CLI][] = []
    for (const entry of items) {
      let item: Command
      if (entry instanceof CLI) {
        item = treeCommand(entry)
        trees.push([item, entry])
      } else {
        item = entry
      }
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
    return [[...groups.values()].flatMap((g) => g.toRegister), trees]
  }

  /**
   * The command tree this mount serves under `cmdName`, null when the name
   * resolves to any other command here. Mirrors Python's
   * `MountEntry.cli_for`.
   */
  cliFor(cmdName: string): CLI | null {
    const tree = this.trees.get(cmdName)
    if (this.resolveCommand(cmdName) !== tree?.[0]) return null
    return tree[1]
  }

  /**
   * What answers `name` on this mount, in the order to try.
   *
   * A rendered filetype's renderer answers a read before `read` does,
   * window and all, and the first answer that is not null wins. The rest
   * is the dispatcher's own shape around the VFS's functions: a read takes a
   * window, `append` and `pwrite` are a rewrite where the VFS only writes
   * whole files, and `mkdir` refuses a taken name first. Only a method
   * marked `@vfsCall` is reachable by name, and a custom one is handed the
   * scope and the op's positional arguments.
   * Mirrors Python's `MountEntry._callers`.
   */
  callers(name: string, filetype: string | null, vfs: BaseVFS = this.vfs): OpCall[] {
    if (name === 'read') {
      const levels: OpCall[] = []
      const renderer = filetype !== null ? vfs.renderers[filetype] : undefined
      const render =
        renderer === undefined
          ? undefined
          : (vfs as unknown as Record<string, ReadFn | undefined>)[renderer]
      if (render !== undefined) {
        levels.push((scope, _args, kw) =>
          readWindow(render.bind(vfs), true, scope, kw, handedOf(kw)),
        )
      }
      if (vfs.supports('read')) {
        const read: ReadFn = (path, given, offset, size) =>
          vfs.read(path, given, offset, size, callerSignal())
        levels.push((scope, _args, kw) =>
          readWindow(read, vfs.readsRanges, scope, kw, handedOf(kw)),
        )
      }
      return levels
    }
    if (name === 'write' && vfs.supports('write')) {
      return [(scope, args, kw) => this.writeSource(vfs, scope, writeSource(args), false, kw)]
    }
    if (name === 'append' && (vfs.supports('append') || vfs.supports('write'))) {
      return [(scope, args, kw) => this.writeSource(vfs, scope, writeSource(args), true, kw)]
    }
    if (name === 'truncate' && !vfs.supports(name)) {
      if (!vfs.supports('write')) return []
      return [
        (scope, args, kw) =>
          this.truncateByRewrite(scope, lengthArg(args[0]), kw.no_create === true, kw.index),
      ]
    }
    if (name === 'pwrite' && !vfs.supports(name)) {
      if (!vfs.supports('write')) return []
      return [
        (scope, args, kw) =>
          this.pwriteByRewrite(scope, writeData(args), offsetArg(args[1], scope), kw.index),
      ]
    }
    if (declared(vfs.constructor, name) === null) return []
    if (!vfs.supports(name)) return []
    switch (name) {
      case 'readdir':
        return [(scope, _args, kw) => vfs.readdir(scope, handedOf(kw))]
      case 'stat':
        return [(scope, _args, kw) => vfs.stat(scope, handedOf(kw))]
      case 'pwrite':
        return [
          (scope, args, kw) =>
            vfs.pwrite(
              scope,
              writeData(args),
              offsetArg(args[1], scope),
              handedOf(kw),
              callerSignal(),
            ),
        ]
      case 'create':
        return [(scope, _args, kw) => vfs.create(scope, handedOf(kw))]
      case 'mkdir':
        return [
          (scope, _args, kw) => this.mkdir(scope, kw.parents === true, kw.index, handedOf(kw)),
        ]
      case 'unlink':
        return [(scope, _args, kw) => vfs.unlink(scope, handedOf(kw))]
      case 'rmdir':
        return [(scope, _args, kw) => vfs.rmdir(scope, handedOf(kw))]
      case 'rename':
        return [(scope, args, kw) => vfs.rename(scope, dstArg(args[0]), handedOf(kw))]
      case 'copy':
        return [(scope, args, kw) => vfs.copy(scope, dstArg(args[0]), callerSignal(), handedOf(kw))]
      case 'dir_copy':
        return [(scope, args, kw) => vfs.dirCopy(scope, dstArg(args[0]), handedOf(kw))]
      case 'rm_r':
        return [(scope, _args, kw) => vfs.rmR(scope, handedOf(kw))]
      case 'first_lines':
        return [(scope, args, kw) => vfs.firstLines(scope, args[0] as number, handedOf(kw))]
      case 'last_lines':
        return [(scope, args, kw) => vfs.lastLines(scope, args[0] as number, handedOf(kw))]
      case 'line_count':
        return [(scope, _args, kw) => vfs.lineCount(scope, handedOf(kw))]
      case 'checksum':
        return [(scope, args, kw) => vfs.checksum(scope, args[0] as string, handedOf(kw))]
      case 'follow':
        return [
          (scope, args, kw) =>
            vfs.follow(scope, args[0] as number, args[1] as number, handedOf(kw)),
        ]
      case 'read_tree':
        return [(scope, _args, kw) => vfs.readTree(scope, handedOf(kw))]
      case 'search':
        return [(scope, args, kw) => vfs.search(scope, args[0] as SearchQuery, handedOf(kw))]
      case 'files_containing':
        return [
          (scope, args, kw) =>
            vfs.filesContaining(
              scope,
              args[0] as string,
              { wholeWord: kw.whole_word === true, ignoreCase: kw.ignore_case === true },
              handedOf(kw),
            ),
        ]
      case 'lines_containing':
        return [
          (scope, args, kw) =>
            vfs.linesContaining(
              scope,
              args[0] as string,
              { ignoreCase: kw.ignore_case === true },
              handedOf(kw),
            ),
        ]
      case 'before_full_walk':
        return [
          (scope, _args, kw) =>
            vfs.beforeFullWalk(scope, typeof kw.files === 'number' ? kw.files : null, handedOf(kw)),
        ]
      case 'truncate':
        return [
          (scope, args, kw) =>
            vfs.truncate(scope, lengthArg(args[0]), kw.no_create === true, handedOf(kw)),
        ]
      case 'setattr':
        return [(scope, _args, kw) => vfs.setattr(scope, kw as SetAttrFields, handedOf(kw))]
      default: {
        const method = (vfs as unknown as Record<string, (...args: unknown[]) => unknown>)[name]
        return method === undefined ? [] : [(scope, args) => method.call(vfs, scope, ...args)]
      }
    }
  }

  /**
   * A write or append of bytes or a stream, handed to the VFS's `write` /
   * `append` as it came, an append by rewrite where it has none. Every
   * `write` is told `atomic`; one that collects first already lands whole.
   * Mirrors Python's `MountEntry._write_op` / `_append_op`.
   */
  private async writeSource(
    vfs: BaseVFS,
    path: PathSpec,
    data: ByteSource,
    append: boolean,
    kw: OpKwargs,
  ): Promise<unknown> {
    try {
      if (!append) {
        return await vfs.write(path, data, callerSignal(), handedOf(kw), kw.atomic === true)
      }
      if (vfs.supports('append')) return await vfs.append(path, data, handedOf(kw), callerSignal())
      return await this.appendByRewrite(path, await materialize(data), kw.index)
    } finally {
      await closeQuietly(data)
    }
  }

  private appendByRewrite(
    path: PathSpec,
    data: Uint8Array,
    index: IndexCacheStore = this.index,
  ): Promise<unknown> {
    return appendByRewrite(
      (p) => this.readAt(index, p),
      (p, d) => this.writeAt(index, p, d),
      (p) => this.statAt(index, p),
      path,
      data,
    )
  }

  private pwriteByRewrite(
    path: PathSpec,
    data: Uint8Array,
    offset: number,
    index: IndexCacheStore = this.index,
  ): Promise<void> {
    return pwriteByRewrite(
      (p) => this.readAt(index, p),
      (p, d) => this.writeAt(index, p, d),
      (p) => this.statAt(index, p),
      path,
      data,
      offset,
    )
  }

  private truncateByRewrite(
    path: PathSpec,
    length: number,
    noCreate: boolean,
    index: IndexCacheStore = this.index,
  ): Promise<void> {
    return truncateByRewrite(
      (p) => this.readAt(index, p),
      (p, d) => this.writeAt(index, p, d),
      path,
      length,
      noCreate,
    )
  }

  /** The VFS's read of a whole file, handed what is at its path. */
  private readAt(index: IndexCacheStore, path: PathSpec): Promise<Uint8Array> {
    return collected(this.answer(this.vfs, index, path), path, true)
  }

  /**
   * What `vfs`'s read of a whole file answers, called with the stats it
   * declares. Mirrors Python's `_answer`.
   */
  private async answer(
    vfs: BaseVFS,
    index: IndexCacheStore,
    path: PathSpec,
    signal?: AbortSignal,
  ): Promise<ByteSource> {
    return vfs.read(path, await this.handedFor('read', path, null, index), 0, null, signal)
  }

  /** The VFS's write of a whole file, handed what is at its path and the directory it goes in. */
  private async writeAt(
    index: IndexCacheStore,
    path: PathSpec,
    data: Uint8Array,
  ): Promise<unknown> {
    return this.vfs.write(
      path,
      data,
      callerSignal(),
      await this.handedFor('write', path, null, index),
    )
  }

  private async mkdir(
    path: PathSpec,
    parents: boolean,
    index: IndexCacheStore = this.index,
    handed?: Handed,
  ): Promise<unknown> {
    await refuseTaken((p) => this.statAt(index, p), path, parents)
    if (parents && this.wants('mkdir').includes('parent')) return this.mkdirLevels(path, index)
    const made = await this.vfs.mkdir(path, parents, handed)
    // A directory made new holds nothing yet.
    if (!parents && made instanceof FileStat) await index.setDir(indexKey(this.prefix, path), [])
    return made
  }

  /**
   * `mkdir -p` on a backend that makes a directory inside its parent's entry:
   * one level at a time, from the mount root down. The level above does not
   * exist yet when the one below needs it as its parent, so each level's
   * create answers its new stat and the index keeps it where the next level
   * looks for its parent, with its own listing, which is empty. A level that
   * is there already is passed, a directory or not: a file there is ENOTDIR
   * for the level below, as mkdir(2) finds. Mirrors Python's `_mkdir_levels`.
   */
  private async mkdirLevels(path: PathSpec, index: IndexCacheStore): Promise<unknown> {
    const names = path.vfsPath.split('/').filter((name) => name !== '')
    const root = rstripSlash(this.prefix)
    let made: unknown = undefined
    for (let depth = 1; depth <= names.length; depth++) {
      const level = this.scope(`${root}/${names.slice(0, depth).join('/')}`)
      const key = indexKey(this.prefix, level)
      const found = await this.entry(level, index)
      if (found !== null) {
        if (found.type !== FileType.DIRECTORY) throw enotdir(level)
        continue
      }
      const parent = await this.entry(this.folder(level), index)
      made = await this.vfs.mkdir(level, false, parent === null ? {} : { parent })
      if (made instanceof FileStat) {
        await index.addEntry(key, made)
        await index.setDir(key, [])
      }
    }
    return made
  }

  /** The index key of this mount's root, which no listing names. */
  /**
   * Whether the VFS lists, so the mount keeps its listings as stats. Mirrors
   * Python's `_lists`.
   */
  private get lists(): boolean {
    return this.vfs.supports('readdir')
  }

  private get rootKey(): string {
    return rstripSlash(this.prefix) || '/'
  }

  /**
   * The directory holding `scope`, keyed below this mount; a glob word stands
   * for the directory it lists, and the root holds itself.
   */
  private folder(scope: PathSpec): PathSpec {
    const target = scope.pattern !== null ? scope.dir : scope
    if (indexKey(this.prefix, target) === this.rootKey) return target
    const virtual = rstripSlash(target.virtual)
    return this.scope(virtual.slice(0, virtual.lastIndexOf('/')) || '/')
  }

  /** The stats the VFS's function `name` declares it is handed. */
  private wants(name: string): readonly (keyof Handed)[] {
    return this.vfs.handed[methodName(name)] ?? []
  }

  /**
   * What is at `scope`, as its parent's listing names it, listing the parent
   * when no stored listing does. Under `fresh` the running command's check of
   * `scope` already asked the backend, so its answer stands in for the walk;
   * a check itself always walks. A miss right after a listing of the parent
   * landed, with no listing left now, says only that a check cleared the index
   * mid-lookup, so it is looked up once more. Mirrors Python's `_entry`.
   */
  private async entry(scope: PathSpec, index: IndexCacheStore): Promise<FileStat | null> {
    const key = indexKey(this.prefix, scope)
    if (key === this.rootKey || !this.lists) return null
    if (this.cacheManager !== null && !(index instanceof ListingCheckStore)) {
      const probed = this.cacheManager.probedStat(scope)
      if (probed !== null) return probed
    }
    const listed: string[] = []
    const warm = async (): Promise<string[]> => {
      const names = await this.listed(this.folder(scope), index)
      listed.push(key)
      return names
    }
    let row = await entryAt(index, key, warm)
    if (
      row === null &&
      listed.length > 0 &&
      (await index.listDir(folderOf(key))).status === LookupStatus.NOT_FOUND
    ) {
      row = await entryAt(index, key, warm)
    }
    if (row !== null) return row
    if (await beyondWindow(index, key)) return this.beyond(scope, index)
    if (!(await this.unproven(index, key))) return null
    if (this.asksByPath) return this.beyond(scope, index)
    await index.invalidateDir(folderOf(key))
    return entryAt(index, key, warm)
  }

  /**
   * The row the stored listings answer a stat of `key` with, null for one the
   * backend must answer, a miss they do not prove (`unproven`) included.
   * Mirrors Python's `_stored_row`.
   */
  private async storedRow(index: IndexCacheStore, key: string): Promise<FileStat | null> {
    return this.whole(await storedStat(index, key, (folder) => this.proves(index, folder)))
  }

  /**
   * Whether a complete listing of `folder` proves a name it leaves out absent:
   * always, but on a VFS that checks such a name again (`unproven`), only a
   * listing the running command fetched. Mirrors Python's `_proves`.
   */
  private proves(index: IndexCacheStore, folder: string): boolean {
    const checks = this.asksByPath || this.vfs.supports('write')
    return !checks || index.listedThisCommand(folder)
  }

  /** Whether the VFS's stat asks by path, handed no stored row. */
  private get asksByPath(): boolean {
    return this.lists && this.wants('stat').length === 0
  }

  /**
   * Whether the stored listings leave `key` out without proving it absent
   * (`unprovenMiss`), on a VFS that checks such a name again: one whose stat
   * asks by path (one stat) or one that writes (its folder is listed again),
   * where a stale miss would let a write land over a file another client
   * made. Mirrors Python's `_unproven`.
   */
  private async unproven(index: IndexCacheStore, key: string): Promise<boolean> {
    return (this.asksByPath || this.vfs.supports('write')) && unprovenMiss(index, key)
  }

  /**
   * What is at a path its folder's stored listing leaves out without proving
   * it absent (a window, or a listing another command fetched): the backend's
   * stat of it, handed what is at its parent; null when nothing is. Mirrors
   * Python's `_beyond`.
   */
  private async beyond(scope: PathSpec, index: IndexCacheStore): Promise<FileStat | null> {
    const handed: { -readonly [K in keyof Handed]: Handed[K] } = {}
    if (this.wants('stat').includes('parent')) {
      handed.parent = await this.entry(this.folder(scope), index)
    }
    try {
      return await this.vfs.stat(scope, handed)
    } catch (err) {
      if (!isEnoent(err)) throw err
      console.debug(`nothing unlisted at ${scope.virtual}: ${String(err)}`)
      return null
    }
  }

  /**
   * A directory's children, from its stored listing or listed through the
   * backend and kept. Finding the rows a listing is handed lists its parent,
   * whose fetch may have proved this listing too (a seed). Mirrors Python's
   * `_listed`.
   */
  private async listed(path: PathSpec, index: IndexCacheStore): Promise<string[]> {
    const key = indexKey(this.prefix, path)
    const glob = path.pattern !== null
    const stored = await storedListing(index, key, glob)
    if (stored !== null) return stored
    const handed = await this.handedFor('readdir', path, null, index)
    const seeded = await storedListing(index, key, glob)
    if (seeded !== null) return seeded
    const listed = await this.vfs.readdir(path, handed)
    return keepListing(index, key, listed)
  }

  /** A stat of `path` on this mount, as `callKeyed` answers one. Mirrors Python's `_stat`. */
  private async statAt(index: IndexCacheStore, path: PathSpec): Promise<FileStat> {
    const stored = (await this.stored('stat', path, index)) as FileStat | null
    if (stored !== null) return stored
    return this.vfs.stat(path, await this.handedFor('stat', path, null, index))
  }

  /**
   * The stats the VFS's function `name` declares, each found in the stored
   * listings. Mirrors Python's `_handed`.
   */
  private async handedFor(
    name: string,
    scope: PathSpec,
    dst: PathSpec | null,
    index: IndexCacheStore,
  ): Promise<Handed> {
    const wants = this.wants(name)
    const handed: { -readonly [K in keyof Handed]: Handed[K] } = {}
    if (wants.includes('index')) {
      handed.index = index
      // Under a fresh check such a function answers from the check's hints:
      // walking for its stats would cost the requests it saves.
      if (index instanceof ListingCheckStore) return handed
    }
    for (const stat of HANDED) {
      if (!wants.includes(stat)) continue
      if (stat === 'entry') handed.entry = await this.entry(scope, index)
      else if (stat === 'parent') handed.parent = await this.entry(this.folder(scope), index)
      else if (dst !== null) {
        const there = this.scope(dst.virtual)
        if (stat === 'dstEntry') handed.dstEntry = await this.entry(there, index)
        else handed.dstParent = await this.entry(this.folder(there), index)
      }
    }
    return handed
  }

  /**
   * Run one level with the stats its function declares. A stat a stored
   * listing handed in may be stale: the backend answering ENOENT for it drops
   * the listings it came from, which lists them again, and the level runs once
   * more. A level handed nothing is not run again, nor a stat the listings
   * found nothing at: the backend agrees with them. `found` is the stats
   * already found for this level, null to find them here. Mirrors Python's
   * `_run`.
   */
  private async run(
    name: string,
    call: OpCall,
    scope: PathSpec,
    args: readonly unknown[],
    kwargs: OpKwargs,
    index: IndexCacheStore,
    found: Handed | null = null,
  ): Promise<unknown> {
    // A rename's or a copy's destination is its first argument; a function
    // is handed a stat there only where it declares one.
    const dst = args[0] instanceof PathSpec ? args[0] : null
    const handed = found ?? (await this.handedFor(name, scope, dst, index))
    try {
      return await call(scope, args, { ...kwargs, handed })
    } catch (err) {
      if (
        !isEnoent(err) ||
        !HANDED.some((stat) => handed[stat] != null) ||
        (name === 'stat' && handed.entry == null)
      )
        throw err
      console.debug(`${name} ${scope.virtual} missed its handed rows, asking again: ${String(err)}`)
    }
    await this.forget(scope, dst, index)
    const again = await this.handedFor(name, scope, dst, index)
    return call(scope, args, { ...kwargs, handed: again })
  }

  /** Drop the listings a stale stat was handed from. Mirrors Python's `_forget`. */
  private async forget(
    scope: PathSpec,
    dst: PathSpec | null,
    index: IndexCacheStore,
  ): Promise<void> {
    const paths = [scope]
    if (dst !== null) paths.push(this.scope(dst.virtual))
    for (const path of paths) {
      const key = indexKey(this.prefix, path)
      await index.invalidateDir(folderOf(key))
      await index.invalidateDir(key)
    }
  }

  /**
   * A listing or a stat the stored listings answer, null for one the backend
   * must. Mirrors Python's `_stored`.
   */
  private async stored(name: string, scope: PathSpec, index: IndexCacheStore): Promise<unknown> {
    const key = indexKey(this.prefix, scope)
    if (name === 'readdir') return storedListing(index, key, scope.pattern !== null)
    if (name === 'read_tree') return this.namesOnly ? null : storedTree(index, key)
    if (key === this.rootKey) return null
    const row = await this.storedRow(index, key)
    if (row === null || !this.namesOnly) return row
    return this.cacheManager?.listingTrusted(folderOf(key)) === true ? row : null
  }

  /**
   * A stored row that answers a stat whole, null for one the backend must
   * finish: a file with no size, on a VFS whose stat sizes every file (chroma
   * sizes a folder's pages on its first stat). Mirrors Python's `_whole`.
   */
  private whole(row: FileStat | null): FileStat | null {
    if (
      row !== null &&
      row.size === null &&
      row.type === FileType.FILE &&
      this.vfs.sizesAlwaysKnown
    ) {
      return null
    }
    return row
  }

  /**
   * Whether a kept listing vouches for its children's names only. A folder's
   * version moves when its names change, not when a child is edited in place,
   * so under `fresh` a mount whose listings are checked by folder answers a
   * child's stat from its listing only when the running command listed it.
   * Mirrors Python's `_names_only`.
   */
  private get namesOnly(): boolean {
    return (
      this.read.policy === ReadPolicy.FRESH && this.vfs.listingVersion === ListingVersion.FOLDER
    )
  }

  /**
   * The VFS's read of `scope` as a stream, called on the first pull and
   * handed the stats it declares. Mirrors Python's `_streamed`.
   */
  private async *streamed(
    vfs: BaseVFS,
    scope: PathSpec,
    index: IndexCacheStore,
    signal: AbortSignal | undefined,
  ): AsyncIterable<Uint8Array> {
    yield* asStream(this.answer(vfs, index, scope, signal))
  }

  /**
   * Run `name` on this mount's VFS over a scope already keyed below the
   * mount: each level in turn until one answers with something other than
   * null. A read resolves its renderer by `kwargs.filetype` when the caller
   * names one (null asks for the stored bytes) and by the path's extension
   * otherwise. A VFS with no `read` of its own (gdocs, gsheets, gslides)
   * stores the rendering, so its stored bytes are the renderer's.
   */
  async callKeyed(
    name: string,
    scope: PathSpec,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
    access?: SessionAccess,
  ): Promise<unknown> {
    const named = kwargs.filetype === undefined ? getExtension(scope.virtual) : kwargs.filetype
    const filetype =
      named === null && !this.vfs.supports('read') ? getExtension(scope.virtual) : named
    const vfs = this.viewFor(access)
    const levels = this.callers(name, filetype, vfs)
    if (levels.length === 0) {
      // A copy only reads its source, so the path it is refused at is the
      // destination it would have made.
      const dst = args[0]
      const copies = declared(this.vfs.constructor, name)?.effect === Effect.COPY
      throw enotsup(this.vfs.name, name, copies && dst instanceof PathSpec ? dst : scope)
    }
    taken(name, kwargs)
    this.requireWritable(name, scope, [...args, ...Object.values(kwargs)], access)
    const index = kwargs.index ?? this.index
    const answer = async (): Promise<unknown> => {
      let found: Handed | null = null
      if (this.lists && STORED_OPS.has(name)) {
        let stored = await this.stored(name, scope, index)
        if (stored === null && name === 'readdir') {
          // Finding the rows a listing is handed lists its parent, whose
          // fetch may have proved this listing too (a seed).
          found = await this.handedFor(name, scope, null, index)
          stored = await this.stored(name, scope, index)
        }
        if (stored !== null) return stored
      }
      for (const call of levels) {
        const result = await this.run(name, call, scope, args, kwargs, index, found)
        found = null
        if (result === null || result === undefined) continue
        const kept = this.lists ? await this.kept(name, scope, index, result) : result
        if (name === 'stat') this.noteLive(scope, index, kept)
        return kept
      }
      return null
    }
    // One listing of a folder at a time: a reader arriving while another
    // lists it waits, then answers from what that one kept.
    if (name === 'readdir' && this.lists) {
      return indexLock(index, indexKey(this.prefix, scope), answer)
    }
    return answer()
  }

  /**
   * Under `fresh`, keep a stat the backend answered as the running command's
   * probe answer: the cache gate would ask the backend the same question
   * again. Only a stat that asked the backend counts: one that takes neither
   * an index of its own nor a row the mount hands it, either of which a
   * listing filled. A probe's own store records through the probe. Mirrors
   * Python's `_note_live`.
   */
  private noteLive(scope: PathSpec, index: IndexCacheStore, result: unknown): void {
    const manager = this.cacheManager
    if (
      manager !== null &&
      this.read.policy === ReadPolicy.FRESH &&
      result instanceof FileStat &&
      !(index instanceof ListingCheckStore) &&
      this.lists &&
      this.wants('stat').length === 0
    ) {
      manager.noteProbed(scope, result)
    }
  }

  /**
   * What a listing or a subtree read answered, kept as listings; a listing
   * answers its children's paths once kept. Mirrors Python's `_kept`.
   */
  private async kept(
    name: string,
    scope: PathSpec,
    index: IndexCacheStore,
    result: unknown,
  ): Promise<unknown> {
    const key = indexKey(this.prefix, scope)
    if (name === 'readdir') {
      return keepListing(index, key, result as readonly FileStat[] | DirListing)
    }
    if (name === 'read_tree' && result instanceof Map) {
      const tree = result as Map<string, FileStat>
      await keepTree(index, key, tree)
      return new Map([...tree].filter(([path]) => path !== ''))
    }
    return result
  }

  /**
   * The VFS's streamed read of a scope keyed below the mount, framed for later
   * pulls. The backend runs on each pull, after this frame is gone, so every
   * pull gets what a call gets around it: the caller's context (session,
   * recorder, cache scope), the mount's recording context, its write context
   * (a read hands its token on only where a write will send it), its revision
   * pins, and the read's timeout, which bounds each pull rather than the whole
   * stream. The mount is held until the stream ends or is closed. A read that
   * is neither async nor handed stats is called as the stream opens, so what
   * it binds (a pipe) is bound before the path can be released. Mirrors
   * Python's `read_stream`.
   */
  readStream(scope: PathSpec, access?: SessionAccess): AsyncIterable<Uint8Array> {
    const vfs = this.viewFor(access)
    if (this.retiring) throw ebusy(this.prefix)
    const limit = this.commandLimits.get('read') ?? null
    const revisions = this.revisions.size > 0 ? this.revisions : null
    const bound = currentCaller()
    const caller: Caller = {
      ...bound,
      recording: bound.recording === null ? null : { ...bound.recording, mountId: this.mountId },
      write: { prefix: this.prefix, context: this.writeContext() },
      revisions: { map: revisions },
    }
    const signal = callerSignal()
    const stream = withPullTimeout(
      this.wants('read').length > 0 || vfs.read.constructor.name === 'AsyncFunction'
        ? this.streamed(vfs, scope, this.index, signal)
        : asStream(runWithCaller(caller, async () => vfs.read(scope, {}, 0, null, signal))),
      limit?.timeoutSeconds ?? null,
      'read',
    )
    return this.activity.hold(withCaller(stream, caller)) as AsyncIterable<Uint8Array>
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

  /**
   * What a write through this mount must carry, null when its writes are
   * unconditional. Bound by both entry points whatever the policy, so an
   * unconditional mount clears a context an outer command's mount set.
   * Mirrors Python's `MountEntry.write_context`.
   */
  writeContext(): WriteContext | null {
    const manager = this.cacheManager
    if (this.write !== WritePolicy.CONDITIONAL || manager === null) return null
    // One object per manager, so this mount's frames compare equal.
    if (this.writeContextFor?.manager !== manager) {
      const vfs = this.vfs
      this.writeContextFor = {
        manager,
        context: {
          vfs: vfs.name,
          // Judged at each write: an S3 mount with no endpoint reads the environment.
          get conditions() {
            return writeConditions(vfs)
          },
          readVersion: (path) => manager.readVersion(path),
          readVersions: (paths) => manager.readVersions(paths),
          drop: (path) => manager.invalidate(path, FileChangeKind.UPDATE),
          keep: (path, version) => manager.keepVersion(path, version),
        },
      }
    }
    return this.writeContextFor.context
  }

  /**
   * The dispatcher's revision pins and write context, one scope. Public for
   * the dispatcher, which calls ops itself rather than through the command entry point.
   */
  runWithWriteRevisions<T>(fn: () => Promise<T>): Promise<T> {
    return runWithWriteContext(this.prefix, this.writeContext(), () =>
      Promise.resolve(runWithRevisions(this.revisions.size > 0 ? this.revisions : null, fn)),
    )
  }

  async runCommand(
    cmdName: string,
    paths: PathSpec[],
    texts: string[],
    flags: Record<string, FlagValue>,
    ctx: Partial<Context> = {},
    limitOverride: Limit | null = null,
  ): Promise<[ByteSource | null, IOResult]> {
    return this.use(async (): Promise<[ByteSource | null, IOResult]> => {
      const handlers = await this.pickHandlers(cmdName, paths, ctx)
      if (handlers.length === 0) {
        return [
          null,
          new IOResult({
            exitCode: 127,
            stderr: encodeText(`${cmdName}: command not found`),
          }),
        ]
      }
      const probe = walkProbeOf(ctx)
      const access = ctx.session?.access()
      return this.inCommandScope(probe, async (): Promise<[ByteSource | null, IOResult]> => {
        for (const cmd of handlers) {
          const user = this.isUserCommand(cmd)
          const operands = user ? this.keyedPaths(cmdName, paths) : paths.map(virtualKey)
          const runCtx = user
            ? this.commandCtx(this.keyedFlags(flags), ctx, this.prefix)
            : this.commandCtx(virtualFlags(flags), ctx, '')
          const refusal = this.readOnlyRefusal(cmdName, cmd, flags, access)
          if (refusal !== null) return [null, refusal]
          const result = await this.runOne(
            cmdName,
            cmd,
            operands,
            texts,
            { ...runCtx, spec: namedSpec(cmd, cmdName) },
            limitOverride,
            access,
            paths,
          )
          if (result !== null) return result
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
    ctx: Partial<Context>,
  ): Promise<Command[]> {
    let extension =
      paths.length > 0 && paths[0] !== undefined ? getExtension(paths[0].virtual) : null
    const first = paths[0]
    const statPath = vfsStatPath(ctx.vfs)
    if (
      extension !== null &&
      extension !== '' &&
      first !== undefined &&
      statPath !== undefined &&
      this.cmds.has(cmdKey(cmdName, extension))
    ) {
      const entry = await statPath(first)
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
   * Stamp this mount's backend key onto each path operand, for a handler that
   * addresses its backend through the mount's accessor (a user command, a
   * command tree's leaf); mirage's own commands get every path keyed by its
   * whole virtual path (`virtualKey`) and reach it through their files. A
   * stdin `-` routed nowhere, so it rides on whichever mount runs the line,
   * beside the operands that chose it. Mirrors Python's
   * MountEntry._keyed_paths.
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
   * once, through its files, which is where the namespace facts (links,
   * nested mount roots, a trailing slash) are in view, so expanding here
   * would lose what the handler needs. Python's dispatcher never expands
   * either. The working directory is keyed below `prefix`: this mount's for a
   * handler `keyedPaths` keys the operands of, empty for mirage's own
   * commands, whose paths keep their whole virtual path. Mirrors Python's
   * MountEntry._command_ctx.
   */
  private commandCtx(
    flags: Record<string, FlagValue>,
    ctx: Partial<Context>,
    mountPrefix: string,
  ): Context {
    const prefix = rstripSlash(mountPrefix)
    const cwd = (ctx.cwd ?? ROOT_CWD).virtual
    return {
      ...ctx,
      // Said on the files, not only bound in the async context, so a read of
      // this run's mount after an await answers for this run.
      ...(ctx.vfs !== undefined ? { vfs: ctx.vfs.servedBy([this.prefix, this.mode]) } : {}),
      stdin: ctx.stdin ?? null,
      flags,
      cwd: new PathSpec({
        virtual: cwd,
        directory: cwd,
        vfsPath: mountKey(cwd, prefix),
        resolved: false,
      }),
    }
  }

  /**
   * Run `fn` with what a handler's backend calls read bound: the mode the
   * command tier's mode guard holds each write to (its own region's mode),
   * what the command tier's walk guard proves an operand's `.` and `..`
   * with, the recorder's mount, the mount's cache manager and write context,
   * and the snapshot revision pins. Mirrors Python's MountEntry._command_scope.
   */
  private inCommandScope<T>(probe: WalkProbe | null, fn: () => Promise<T>): Promise<T> {
    const outer = currentCaller()
    return runWithCaller(
      {
        ...outer,
        recording: outer.recording === null ? null : { ...outer.recording, mountId: this.mountId },
        revisions: { map: this.revisions.size > 0 ? this.revisions : null },
        cache: { manager: this.cacheManager },
        write: { prefix: this.prefix, context: this.writeContext() },
        mount: [this.prefix, this.mode],
        walkProbe: probe === null ? outer.walkProbe : [this.prefix, probe],
      },
      fn,
    )
  }

  /**
   * Refuse a user command that writes, on a read-only mount.
   *
   * Mirage's own commands write through the dispatcher, which refuses each
   * write in the command's own GNU voice, because only the write knows
   * whether a line writes: `gzip -c`, `tar -t` and `split -n 1/2` read a
   * read-only mount like any reader, and `gzip f` is refused at the write of
   * `f.gz`. A user command (`isUserCommand`) may reach its service some other
   * way, which no gate would see, so one that writes is refused here, before
   * it runs. strongestModeUnder, not effectiveMode: a mount whose only
   * writable region is a show entry still runs it. Only wrapper-owned
   * responses (an injected help or version) bypass it: a handler that
   * declares `--help` itself is handed the flag and runs. The trailing
   * newline is load-bearing: stderr accumulates across a line. `served` is
   * the command this mount serves `cmd` under, which says whether it is a
   * user command: a tree's root for one of its leaves, which is built for its
   * one run and never registered. Mirrors Python's
   * MountEntry._read_only_refusal.
   */
  private readOnlyRefusal(
    cmdName: string,
    cmd: Command,
    flags: Record<string, FlagValue>,
    access?: SessionAccess,
    served?: Command,
  ): IOResult | null {
    const infoOnly =
      (flags.help === true && hasInjectedHelp(cmd.spec)) ||
      (flags.version === true && hasInjectedVersion(cmd.spec))
    if (
      cmd.write &&
      this.isUserCommand(served ?? cmd) &&
      !infoOnly &&
      strongestModeUnder(this.prefix, this.mode, access) === MountMode.READ
    ) {
      return new IOResult({
        exitCode: 1,
        stderr: encodeText(`${cmdName}: read-only mount at ${this.prefix}\n`),
      })
    }
    return null
  }

  /**
   * Whether `cmd` is a user command: one this mount serves that is not
   * mirage's own, registered through `registerCommands` (a VFS's handed
   * commands among them) rather than as a builtin. Mirrors Python's
   * MountEntry._is_user_command.
   */
  private isUserCommand(cmd: Command): boolean {
    const key = cmdKey(cmd.name, cmd.filetype)
    return this.userKeys.has(key) && this.cmds.get(key) === cmd
  }

  /**
   * Run one handler under the mount-resolved timeout, through the runner a
   * CLI leaf shares, in this mount's voice.
   *
   * The dispatch-level guard only sees default limits (the mount is unknown
   * before routing), so the mount-resolved timeout must also bound the
   * command body: eager commands do their work inside cmd.fn, where the
   * stream-consumption guard never runs. limitOverride is the caller's
   * profile, mount and workspace entry; a null one is "no opinion" and must
   * not shadow this mount's own table. `typed` are the operands as the line
   * typed them, which a file error names. A user
   * command that declares a write reaches its backend through its own
   * handle, past the dispatcher's per-path invalidation, so this mount drops
   * its caches once it has run; mirage's own commands write through the
   * dispatcher and drop nothing. Mirrors Python's MountEntry._run_one.
   */
  private async runOne(
    cmdName: string,
    cmd: Command,
    paths: PathSpec[],
    texts: string[],
    ctx: Context,
    limitOverride: Limit | null,
    access: SessionAccess | undefined,
    typed: readonly PathSpec[],
  ): Promise<CommandFnResult> {
    const limit = resolveLimit(
      cmdName,
      [],
      cmd.limit,
      limitOverride ?? this.commandLimits.get(cmdName) ?? null,
    )
    const accessor = this.viewFor(access).accessor
    return this.runIn(
      cmdName,
      limit,
      ctx,
      mountVoice(cmdName, typed),
      { command: cmdName, prefixes: [this.prefix], declared: cmd.limit ?? null },
      cmd.write && this.isUserCommand(cmd),
      // Deferred, so a handler that throws before it returns a promise is
      // still the runner's to word and to drop the caches after.
      (runCtx) => Promise.resolve().then(() => cmd.fn(accessor, paths, texts, runCtx)),
    )
  }

  /**
   * Run one leaf of a command tree this mount serves.
   *
   * The executor walked the line and parsed the leaf's words, as it does an
   * installed CLI's; the leaf runs here as a command does: on this mount's
   * accessor, in its scope, under the read-only refusal for its own `write`
   * and, being a user command that holds the raw handle, the refusal a
   * restricting session gets. Its failures speak in a CLI's voice. Mirrors
   * Python's `MountEntry.run_leaf`.
   */
  async runLeaf(
    prog: string,
    cli: CLI,
    handler: CLIHandler,
    paths: PathSpec[],
    texts: string[],
    ctx: Context,
    limit: Limit | null,
  ): Promise<CommandFnResult> {
    const root = this.resolveCommand(cli.spec.name)
    const fn = handler.fn
    if (fn === null || root === null) throw new Error(`${prog}: no command tree serves it here`)
    const leaf = new Command({
      name: prog,
      spec: ctx.spec ?? cli.spec,
      vfs: null,
      filetype: null,
      fn,
      write: handler.write,
      limit: handler.limit,
    })
    return this.use(async (): Promise<CommandFnResult> => {
      const keyedPaths = this.keyedPaths(prog, paths)
      const probe = walkProbeOf(ctx)
      const access = ctx.session?.access()
      const flags = this.keyedFlags(ctx.flags)
      const runCtx = this.commandCtx(flags, ctx, this.prefix)
      return this.inCommandScope(probe, async (): Promise<CommandFnResult> => {
        // No flag here is answered for the leaf: walkLeaf answered the
        // tree's own help, and the leaf is handed the rest.
        const refusal = this.readOnlyRefusal(prog, leaf, {}, access, root)
        if (refusal !== null) return [null, refusal]
        const accessor = this.viewFor(access).accessor
        return this.runIn(
          prog,
          limit,
          runCtx,
          cliVoice(prog),
          { command: prog, prefixes: [this.prefix], declared: handler.limit },
          handler.write && this.isUserCommand(root),
          (leafCtx) =>
            answered(Promise.resolve().then(() => fn(accessor, keyedPaths, texts, leafCtx))),
        )
      })
    })
  }

  /**
   * Run a handler body through the shared runner with what this mount binds
   * around it. The runner abandons the promise, it cannot cancel it; the
   * aborted signal lets a runtime kill what it spawned (python cancels the
   * task instead). The ambient context.signal is a background job's kill
   * channel, folded into the same wire. timeoutSeconds rides along so an
   * engine that executes on the event loop (quickjs) can interrupt itself
   * when the timer cannot fire.
   */
  private runIn(
    name: string,
    limit: Limit | null,
    ctx: Context,
    voice: HandlerVoice,
    producer: Producer,
    writes: boolean,
    call: (ctx: Context) => Promise<CommandFnResult>,
  ): Promise<CommandFnResult> {
    const timeout = limit !== null ? limit.timeoutSeconds : null
    const guard = timeout !== null && timeout > 0 ? new AbortController() : null
    const runSignal = mergeSignals(guard?.signal, ctx.signal)
    const runCtx =
      runSignal !== undefined
        ? {
            ...ctx,
            signal: runSignal,
            ...(timeout !== null && timeout > 0 ? { timeoutSeconds: timeout } : {}),
          }
        : ctx
    // No hold past the timeout: an unmount waits on this mount's activity
    // with no grace, so a body, or a renderer of the rows it handed over,
    // that ignores the abort is let go rather than waited on.
    return runHandler(call(runCtx), name, limit, producer, voice, {
      scope: (result) => wrapMountStreams(result, this.activity),
      ...(writes ? { drop: () => this.dropCaches() } : {}),
      ...(runSignal !== undefined ? { signal: runSignal } : {}),
      ...(guard !== null ? { abort: guard } : {}),
      ...(runCtx.vfs !== undefined ? { vfs: runCtx.vfs } : {}),
    })
  }

  /**
   * Drop what this mount keeps after a write that went past the dispatcher:
   * its listings and bodies (`CacheManager.drop`), and the answers its client
   * keeps of its own (`Accessor.forget`). Mirrors Python's
   * `MountEntry.drop_caches`.
   *
   * @param bodies drop the bodies too; false when the registry clears the
   *   whole file cache itself.
   */
  async dropCaches(bodies = true): Promise<void> {
    if (this.cacheManager !== null) await this.cacheManager.drop(bodies)
    else await this.indexStore.invalidate()
    this.accessor.forget?.()
  }

  /** The client this mount's VFS reaches its backend with. */
  get accessor(): Accessor {
    return this.vfs.accessor
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
    access?: SessionAccess,
  ): Promise<unknown> {
    return this.use(async (): Promise<unknown> => {
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
      // A file call is never cut: only the op entry's timeout applies,
      // bounding the backend call itself.
      const opOverride = this.commandLimits.get(name) ?? null
      const opTimeout = opOverride !== null ? opOverride.timeoutSeconds : null
      return runWithMountContext(
        () =>
          this.runWithWriteRevisions(async () => {
            const result = await runWithTimeout(
              this.callKeyed(name, scope, args, effectiveKwargs, access),
              opTimeout,
              name,
            )
            return result === null || result === undefined
              ? null
              : wrapStream(result, this.mountId, this.activity)
          }),
        this.mountId,
      )
    })
  }

  /**
   * The op entry's timeout for `name`, null for none. A file call is never
   * cut: only the op entry's timeout applies, bounding the backend call
   * itself. Mirrors Python's _op_timeout.
   */
  opTimeout(name: string): number | null {
    return this.commandLimits.get(name)?.timeoutSeconds ?? null
  }

  /** `path` as this mount's VFS addresses it. Mirrors Python's _scope. */
  private scope(path: string): PathSpec {
    const lastSlash = path.lastIndexOf('/')
    return new PathSpec({
      virtual: path,
      directory: lastSlash > 0 ? path.slice(0, lastSlash) : '/',
      vfsPath: mountKey(path, rstripSlash(this.prefix)),
    })
  }

  /**
   * Whether this mount's store may copy `src` from `source`'s, store to
   * store. Not when this mount's VFS cannot copy from that one, nor when the
   * store's object is not what a move's read and write would carry: a cached,
   * pinned or rendered source reads other bytes, and a conditional mount on
   * either end holds a version for the write or for `mv`'s delete. Asked
   * before the copy's deadline starts. Mirrors Python's `can_copy_from`.
   */
  async canCopyFrom(source: MountEntry, src: string): Promise<boolean> {
    return !(
      !this.vfs.supports('copyFrom') ||
      this.write === WritePolicy.CONDITIONAL ||
      source.write === WritePolicy.CONDITIONAL ||
      source.revisions.has(src) ||
      source.renders(getExtension(src)) ||
      (source.cacheManager !== null && (await source.cacheManager.isCached(source.scope(src))))
    )
  }

  /**
   * Copy a file from `source`'s store into this mount's, store to store,
   * under the mount's `copy` timeout. For `cp` and `mv` between two mounts,
   * once the dispatcher has judged `src` as a read and `dst` as a create and
   * `canCopyFrom` has said yes. The VFS rejects EXDEV when it cannot make the
   * copy after all, and the caller moves the bytes itself. `onCall` receives
   * the store's own call once it starts, which a timeout does not stop.
   * Mirrors Python's `copy_from`.
   */
  async copyFrom(
    source: MountEntry,
    src: string,
    dst: string,
    onCall?: (storeCall: Promise<unknown>) => void,
  ): Promise<void> {
    await this.use(() =>
      source.use(() =>
        this.framed('copy', () => {
          this.requireWritable('write', PathSpec.fromStrPath(dst), [])
          const pending = this.vfs.copyFrom(source.vfs, source.scope(src), this.scope(dst))
          onCall?.(pending)
          return pending
        }),
      ),
    )
  }

  /**
   * Read several whole files on this mount in one request, under the mount's
   * `read` timeout. For the dispatcher's read-ahead, once it has walked and
   * followed each path; keyed by virtual path, a file left out is read on its
   * own later. Mirrors Python's `read_many`.
   */
  async readMany(paths: readonly string[], limit: number): Promise<Map<string, Uint8Array>> {
    return this.use(() =>
      this.framed('read', () =>
        this.batchRead(
          paths.map((p) => this.scope(p)),
          limit,
        ),
      ),
    )
  }

  /**
   * Run one backend call as `call` frames its own: in this mount's recording
   * and write contexts, under the op's timeout. Mirrors Python's `_framed`.
   */
  private framed<T>(op: string, work: () => Promise<T>): Promise<T> {
    return runWithMountContext(
      () => this.runWithWriteRevisions(() => runWithTimeout(work(), this.opTimeout(op), op)),
      this.mountId,
    )
  }

  /**
   * The VFS's batch read, handed what is at each path and at its folder as
   * the stored listings name them, where it declares them. Mirrors Python's
   * `_read_many`.
   */
  private async batchRead(scopes: PathSpec[], limit: number): Promise<Map<string, Uint8Array>> {
    const wants = this.wants('readMany')
    const index = this.index
    const handed: Handed[] = []
    for (const scope of scopes) {
      const one: { -readonly [K in keyof Handed]: Handed[K] } = {}
      if (wants.includes('entry')) one.entry = await this.entry(scope, index)
      if (wants.includes('parent')) one.parent = await this.entry(this.folder(scope), index)
      handed.push(one)
    }
    return this.vfs.readMany(scopes, limit, handed)
  }

  /**
   * Rank several scopes on this mount as one query, under the mount's
   * `search` timeout. For the dispatcher, once it has walked, followed and
   * admitted each scope as it does a `search`'s one. Mirrors Python's
   * `search_many`.
   */
  async searchMany(
    paths: readonly string[],
    query: SearchQuery,
  ): Promise<[string, string][] | null> {
    return this.use(() =>
      this.framed('search', () =>
        this.vfs.searchMany(
          paths.map((p) => this.scope(p)),
          query,
        ),
      ),
    )
  }
}

/** Preserve a streaming operation's recording owner after its dispatch frame exits. */
export function wrapStream(result: unknown, mountId: string, activity: Activity): unknown {
  if (result !== null && typeof result === 'object' && Symbol.asyncIterator in result) {
    return activity.hold(withMountContext(result as AsyncIterable<Uint8Array>, mountId))
  }
  return result
}

// Keep the command's caller on the stream the command handed back, so a
// deferred backend read records under the mount and reads the revisions its
// command bound, as an eager one does. Called inside the mount's command
// scope. Mirrors python's _wrap_mount_streams.
function wrapMountStreams(
  result: [ByteSource | null, IOResult],
  activity: Activity,
): [ByteSource | null, IOResult] {
  const [stream, io] = result
  if (stream === null || stream instanceof Uint8Array) return [stream, io]
  return [activity.hold(withCaller(stream, currentCaller())), io]
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
