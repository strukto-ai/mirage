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
import { captureSessionContext } from '../../context/session_context.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { coerceReadPolicy } from './read_policy.ts'
import { KeyLock } from '../../cache/lock.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { type Accessor, NOOPAccessor } from '../../accessor/base.ts'
import type {
  CommandFn,
  CommandFnResult,
  CommandOpts,
  ExecContext,
  RegisteredCommand,
} from '../../commands/config.ts'
import { hasInjectedVersion } from '../../commands/config.ts'
import { ROOT_CWD } from '../../commands/constants.ts'
import type { OpKwargs } from '../../ops/registry.ts'

const NOOP_ACCESSOR = new NOOPAccessor()
import { getExtension } from '../../commands/resolve.ts'
import { resolveLimit } from '../../policy/index.ts'
import { runWithTimeout } from '../../commands/builtin/utils/limit.ts'
import { CommandTimeoutError } from '../../commands/errors.ts'
import type { CommandSpec, FlagValue } from '../../commands/spec/types.ts'
import { CachableAsyncIterator } from '../../io/cachable_iterator.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult } from '../../io/types.ts'
import { captureCacheContext, runWithCacheManager } from '../../cache/context.ts'
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
import type { RegisteredOp } from '../../ops/registry.ts'
import type { VFS } from '../../vfs/base.ts'
import {
  type Limit,
  type ReadSpec,
  DEFAULT_READ_SPEC,
  FileType,
  MountMode,
  PathSpec,
} from '../../types.ts'
import { ebusy, enotsup } from '../../utils/errors.ts'
import { rstripSlash } from '../../utils/slash.ts'
import {
  effectiveMountMode,
  requirePathsWritable,
  runWithMountGate,
  strongestModeUnder,
} from '../../context/session_context.ts'
import { compareCodePoints } from '../../utils/sort.ts'

type CmdKey = string
type OpKey = string

// Ops that mutate everything under their endpoints in one backend call
// (a directory rename relocates its whole subtree), so the door also
// refuses a read-only region below either endpoint. The removal ops
// stay per-path: the runtimes compose rmtree from unlink/rmdir, and
// each of those answers for its own path above.
const SUBTREE_OPS = new Set(['rename'])

function cmdKey(name: string, filetype: string | null): CmdKey {
  return `${name}\u0000${filetype ?? ''}`
}

function isRegisteredOp(item: RegisteredCommand | RegisteredOp): item is RegisteredOp {
  return typeof (item as RegisteredOp).fn === 'function' && !('spec' in item)
}

function opKey(name: string, filetype: string | null): OpKey {
  return `${name}\u0000${filetype ?? ''}`
}

function crossKey(name: string, targetVfs: string): string {
  return `${name}\u0000${targetVfs}`
}

export interface MountInit {
  prefix: string
  vfs: VFS
  mode?: MountMode
  /** How this mount's cached bytes are revalidated. */
  read?: ReadSpec
}

export class MountEntry {
  readonly mountId = uuid7()
  readonly prefix: string
  readonly vfs: VFS
  mode: MountMode
  readonly read: ReadSpec
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

  private readonly cmds = new Map<CmdKey, RegisteredCommand>()
  private readonly generalCmds = new Map<string, RegisteredCommand>()
  private readonly cmdSpecs = new Map<string, CommandSpec>()
  readonly commandLimits = new Map<string, Limit>()
  private readonly ops = new Map<OpKey, RegisteredOp>()
  private readonly generalOps = new Map<string, RegisteredOp>()
  private readonly crossCmds = new Map<string, RegisteredCommand>()
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
    this.prefix = prefix
    this.vfs = init.vfs
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
  }

  /** Prepare and retain the VFS while its glob hook reads metadata. */
  async expandGlob(paths: readonly PathSpec[], prefix: string): Promise<PathSpec[]> {
    return this.use(async () => {
      const call = async (): Promise<PathSpec[]> => {
        await this.ensureReady()
        return this.vfs.glob === undefined ? [...paths] : this.vfs.glob(paths, prefix)
      }
      return this.cacheManager === null ? call() : this.cacheManager.withMutation(call)
    })
  }

  /** Metadata access bound to this mount's ownership. */
  get index(): IndexCacheStore | undefined {
    const index = this.vfs.index
    return index === undefined ? undefined : (this.cacheManager?.scopeIndex(index) ?? index)
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

  register(cmd: RegisteredCommand): void {
    this.cmds.set(cmdKey(cmd.name, cmd.filetype), cmd)
    this.cmdSpecs.set(cmd.name, cmd.spec)
    this.prefixIndex = null
  }

  registerGeneral(cmd: RegisteredCommand): void {
    this.generalCmds.set(cmd.name, cmd)
    this.cmdSpecs.set(cmd.name, cmd.spec)
    this.prefixIndex = null
  }

  resolveCommand(cmdName: string, extension: string | null = null): RegisteredCommand | null {
    if (extension !== null && extension !== '') {
      const specific = this.cmds.get(cmdKey(cmdName, extension))
      if (specific !== undefined) return specific
    }
    const byVfs = this.cmds.get(cmdKey(cmdName, null))
    if (byVfs !== undefined) return byVfs
    const general = this.generalCmds.get(cmdName)
    if (general !== undefined) return general
    // Fall back to any filetype variant so callers without an extension can
    // still find the command; the actual handler is picked by executeCmd.
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

  isGeneralCommand(cmdName: string): boolean {
    return this.generalCmds.has(cmdName)
  }

  allCommands(): readonly RegisteredCommand[] {
    const seen = new Set<string>()
    const out: RegisteredCommand[] = []
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

  filetypeHandlers(cmdName: string): Record<string, CommandFn> {
    // Null prototype: filetype names are registration-controlled.
    const fns: Record<string, CommandFn> = Object.create(null) as Record<string, CommandFn>
    for (const [key, rc] of this.cmds) {
      if (rc.name === cmdName && rc.filetype !== null) {
        if (!(rc.filetype in fns)) fns[rc.filetype] = rc.fn
      }
      void key
    }
    return fns
  }

  unregister(names: string[]): void {
    for (const name of names) {
      for (const [key, rc] of this.cmds) {
        if (rc.name === name) this.cmds.delete(key)
      }
      this.generalCmds.delete(name)
      this.cmdSpecs.delete(name)
      for (const [key, ro] of this.ops) {
        if (ro.name === name) this.ops.delete(key)
      }
      this.generalOps.delete(name)
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

  registeredOps(): Record<string, (string | null)[]> {
    const result = new Map<string, (string | null)[]>()
    for (const ro of this.ops.values()) {
      const list = result.get(ro.name) ?? []
      list.push(ro.filetype)
      result.set(ro.name, list)
    }
    for (const name of this.generalOps.keys()) {
      if (!result.has(name)) result.set(name, [])
    }
    return sortFiletypeMap(result)
  }

  // ── cross-mount registration ─────────────────────

  registerCross(cmd: RegisteredCommand, targetResourceType: string): void {
    this.crossCmds.set(crossKey(cmd.name, targetResourceType), cmd)
  }

  resolveCross(cmdName: string, targetResourceType: string): RegisteredCommand | null {
    return this.crossCmds.get(crossKey(cmdName, targetResourceType)) ?? null
  }

  // ── op registration ───────────────────────────────

  registerOp(op: RegisteredOp): void {
    this.ops.set(opKey(op.name, op.filetype), op)
  }

  registerGeneralOp(op: RegisteredOp): void {
    this.generalOps.set(op.name, op)
  }

  /**
   * Batch-register commands and ops. Mirrors Python's
   * `Mount.register_fns(...)`. Each entry is a `RegisteredCommand` or
   * `RegisteredOp`; commands with `vfs: null` go to the general
   * table, ops with `vfs: null` likewise. Multi-VFS entries
   * (sharing the same name across mounts) are filtered to this
   * mount's VFS kind; if a name has entries but none match this
   * mount, throw.
   */
  registerFns(items: readonly (RegisteredCommand | RegisteredOp)[]): void {
    const kind = this.vfs.kind
    interface Group<T> {
      toRegister: T[]
      attempted: Set<string>
    }
    const cmdGroups = new Map<string, Group<RegisteredCommand>>()
    const opGroups = new Map<string, Group<RegisteredOp>>()
    for (const item of items) {
      if (isRegisteredOp(item)) {
        let g = opGroups.get(item.name)
        if (!g) {
          g = { toRegister: [], attempted: new Set() }
          opGroups.set(item.name, g)
        }
        if (item.vfs === null || item.vfs === kind) g.toRegister.push(item)
        else g.attempted.add(item.vfs)
      } else {
        let g = cmdGroups.get(item.name)
        if (!g) {
          g = { toRegister: [], attempted: new Set() }
          cmdGroups.set(item.name, g)
        }
        if (item.vfs === null || item.vfs === kind) g.toRegister.push(item)
        else g.attempted.add(item.vfs)
      }
    }
    for (const [name, g] of cmdGroups) {
      if (g.toRegister.length === 0) {
        const list = [...g.attempted].sort(compareCodePoints)
        throw new Error(
          `command '${name}' is for VFS(s) [${list.map((r) => `'${r}'`).join(', ')}], not '${kind}'`,
        )
      }
    }
    for (const [name, g] of opGroups) {
      if (g.toRegister.length === 0) {
        const list = [...g.attempted].sort(compareCodePoints)
        throw new Error(
          `op '${name}' is for VFS(s) [${list.map((r) => `'${r}'`).join(', ')}], not '${kind}'`,
        )
      }
    }
    for (const g of cmdGroups.values()) {
      for (const cmd of g.toRegister) {
        if (cmd.vfs === null) this.registerGeneral(cmd)
        else this.register(cmd)
      }
    }
    for (const g of opGroups.values()) {
      for (const o of g.toRegister) {
        if (o.vfs === null) this.registerGeneralOp(o)
        else this.registerOp(o)
      }
    }
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

  async executeCmd(
    cmdName: string,
    paths: PathSpec[],
    texts: string[],
    flags: Record<string, FlagValue>,
    context: ExecContext = {},
  ): Promise<[ByteSource | null, IOResult]> {
    return this.use(async (): Promise<[ByteSource | null, IOResult]> => {
      let extension =
        paths.length > 0 && paths[0] !== undefined ? getExtension(paths[0].virtual) : null
      // A filetype handler is selected from the operand's NAME, and a
      // directory can carry any extension, so the cascade would hand a
      // renderer a directory to read. One stat settles it, and only when a
      // handler for this exact extension exists, so a mount with no
      // filetype registrations never reaches the probe. The built-in is
      // what a directory should get: it owns GNU's `Is a directory`
      // wording, and the renderer owns nothing but its own format.
      // The DISPATCHER's stat, not the backend's, so a mount root and a
      // namespace-only directory answer too; null means neither plane saw
      // anything, in which case the renderer reports its own miss.
      const first = paths[0]
      if (
        extension !== null &&
        extension !== '' &&
        first !== undefined &&
        context.statPath !== undefined &&
        this.cmds.has(cmdKey(cmdName, extension))
      ) {
        const entry = await context.statPath(first.virtual)
        if (entry !== null && entry.type === FileType.DIRECTORY) extension = null
      }

      const handlers = this.resolveCascade(cmdName, extension, this.cmds, this.generalCmds)
      if (handlers.length === 0) {
        return [
          null,
          new IOResult({
            exitCode: 127,
            stderr: new TextEncoder().encode(`${cmdName}: command not found`),
          }),
        ]
      }

      const mountPrefix = rstripSlash(this.prefix)
      const filetypeFns = this.filetypeHandlers(cmdName)
      const isFiletypeCmd =
        extension !== null && extension !== '' && this.cmds.has(cmdKey(cmdName, extension))

      const prefixedPaths = paths.map(
        (p) =>
          new PathSpec({
            virtual: p.virtual,
            directory: p.directory,
            pattern: p.pattern,
            resolved: p.resolved,
            vfsPath: mountKey(p.virtual, mountPrefix),
            rawPath: p.rawPath,
          }),
      )

      // A pattern operand travels to the handler whole. The handler
      // resolves it once, through the shared adapter, which is where the
      // namespace facts (links, nested mount roots, a trailing slash) are
      // in view; the VFS's glob hook serves the shell tier and cannot
      // see them, so expanding here would lose what the handler needs.
      // Python's dispatcher never expands either.

      const accessor = (this.vfs as { accessor?: Accessor }).accessor ?? NOOP_ACCESSOR
      const cmdOpts: CommandOpts = {
        stdin: context.stdin ?? null,
        flags,
        filetypeFns: isFiletypeCmd ? null : filetypeFns,
        mountPrefix,
        command: cmdName,
        cwd: context.cwd ?? ROOT_CWD,
        ...(this.index !== undefined ? { index: this.index } : {}),
        ...(context.dispatch !== undefined ? { dispatch: context.dispatch } : {}),
        ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
        ...(context.env !== undefined ? { env: context.env } : {}),
        ...(context.sessionView !== undefined ? { sessionView: context.sessionView } : {}),
        ...(context.execAllowed !== undefined ? { execAllowed: context.execAllowed } : {}),
        ...(context.execPathAllowed !== undefined
          ? { execPathAllowed: context.execPathAllowed }
          : {}),
        ...(context.runtime !== undefined ? { runtime: context.runtime } : {}),
        ...(context.ns !== undefined ? { ns: context.ns } : {}),
        ...(context.statPath !== undefined ? { statPath: context.statPath } : {}),
        ...(context.readdirPath !== undefined ? { readdirPath: context.readdirPath } : {}),
      }

      // What the command tier's mode guard reads: each write the handler
      // makes is held to its own region's mode.
      return runWithMountGate(this.prefix, this.mode, () =>
        runWithMountContext(
          () =>
            runWithCacheManager(this.cacheManager, () =>
              runWithRevisions(
                this.revisions.size > 0 ? this.revisions : null,
                async (): Promise<[ByteSource | null, IOResult]> => {
                  for (const cmd of handlers) {
                    // Only wrapper-owned responses bypass the write guard.
                    const infoOnly =
                      flags.help === true ||
                      (flags.version === true && hasInjectedVersion(cmd.spec))
                    // A command whose I/O runs under the path guards is
                    // refused where it writes, because only the write knows
                    // whether a line writes: `gzip -c`, `tar -t` and
                    // `split -n 1/2` read a read-only mount like any reader,
                    // and `gzip f` is refused at the write of `f.gz`, in
                    // gzip's own GNU voice. A write command that reaches its
                    // service some other way (trello's id-addressed card
                    // writes, a custom backend's own verb) is refused here,
                    // before it runs, because no door would see its write.
                    // strongestModeUnder, not effectiveMode: a mount whose
                    // only writable region is a show entry still runs it.
                    // The trailing newline is load-bearing: stderr
                    // accumulates across a line.
                    if (
                      cmd.write &&
                      !cmd.pathGuarded &&
                      !infoOnly &&
                      strongestModeUnder(this.prefix, this.mode) === MountMode.READ
                    ) {
                      return [
                        null,
                        new IOResult({
                          exitCode: 1,
                          stderr: new TextEncoder().encode(
                            `${cmdName}: read-only mount at ${this.prefix}\n`,
                          ),
                        }),
                      ]
                    }
                    // The dispatch-level guard only sees default limits
                    // (the mount is unknown before routing), so the
                    // mount-resolved timeout must also bound the command
                    // body: eager commands do their work inside cmd.fn,
                    // where the stream-consumption guard never runs.
                    // limitOverride is the caller's profile, mount and
                    // workspace entry; a null one is "no opinion" and must
                    // not shadow this mount's own table.
                    const resolvedLimit = resolveLimit(
                      cmdName,
                      [],
                      cmd.limit,
                      context.limitOverride ?? this.commandLimits.get(cmdName) ?? null,
                    )
                    const cmdTimeout = resolvedLimit !== null ? resolvedLimit.timeoutSeconds : null
                    // runWithTimeout abandons the promise, it cannot cancel
                    // it; the aborted signal lets a runtime kill what it
                    // spawned (python cancels the task instead). The ambient
                    // context.signal is a background job's kill channel, folded
                    // into the same wire. timeoutSeconds rides along so an
                    // engine that executes on the event loop (quickjs) can
                    // interrupt itself when the timer cannot fire.
                    const guard =
                      cmdTimeout !== null && cmdTimeout > 0 ? new AbortController() : null
                    const runSignal = mergeSignals(guard?.signal, context.signal)
                    const runOpts =
                      runSignal !== undefined
                        ? {
                            ...cmdOpts,
                            signal: runSignal,
                            ...(cmdTimeout !== null && cmdTimeout > 0
                              ? { timeoutSeconds: cmdTimeout }
                              : {}),
                          }
                        : cmdOpts
                    let result: CommandFnResult
                    try {
                      result = await runWithTimeout(
                        Promise.resolve(cmd.fn(accessor, prefixedPaths, texts, runOpts)),
                        cmdTimeout,
                        cmdName,
                      )
                    } catch (err) {
                      if (guard !== null && err instanceof CommandTimeoutError) guard.abort()
                      throw err
                    }
                    if (result !== null) {
                      result[1].producer = {
                        command: cmdName,
                        prefixes: [this.prefix],
                        declared: cmd.limit ?? null,
                      }
                      return wrapMountStreams(result, this.mountId, this.activity)
                    }
                  }
                  return [null, new IOResult()]
                },
              ),
            ),
          this.mountId,
        ),
      )
    })
  }

  async executeOp(
    opName: string,
    path: string,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
  ): Promise<unknown> {
    return this.use(async (): Promise<unknown> => {
      const filetype = getExtension(path)
      const levels = this.resolveCascade(opName, filetype, this.ops, this.generalOps)
      if (levels.length === 0) {
        throw enotsup(this.vfs.kind, opName, path)
      }
      if (levels.some((o) => o.write)) {
        const dst = kwargs.dst
        const endpoints = [PathSpec.fromStrPath(path)]
        if (dst instanceof PathSpec) endpoints.push(dst)
        requirePathsWritable(endpoints, this.prefix, this.mode, SUBTREE_OPS.has(opName))
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
        ...(kwargs.index === undefined && this.index !== undefined ? { index: this.index } : {}),
        ...(filetype !== null && kwargs.filetype === undefined ? { filetype } : {}),
      }
      const accessor = this.vfs.accessor ?? NOOP_ACCESSOR
      // Per-op caps are policy and fire at the op door (postOps); only
      // the timeout stays here, bounding the backend call itself.
      const opOverride = this.commandLimits.get(opName) ?? null
      const opTimeout = opOverride !== null ? opOverride.timeoutSeconds : null
      return runWithMountContext(
        () =>
          runWithRevisions(this.revisions.size > 0 ? this.revisions : null, async () => {
            for (const op of levels) {
              const result = await runWithTimeout(
                Promise.resolve(op.fn(accessor, scope, args, effectiveKwargs)),
                opTimeout,
                opName,
              )
              if (result !== null && result !== undefined) {
                return wrapOpStream(result, this.mountId, this.activity)
              }
            }
            return null
          }),
        this.mountId,
      )
    })
  }
}

/** Preserve a streaming operation's recording owner after its dispatch frame exits. */
export function wrapOpStream(result: unknown, mountId: string, activity: VFSActivity): unknown {
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
// Mirrors python's _wrap_cmd_streams.
function wrapMountStreams(
  result: [ByteSource | null, IOResult],
  mountId: string,
  activity: VFSActivity,
): [ByteSource | null, IOResult] {
  const [stream, io] = result
  const seen = new Map<ByteSource, ByteSource>()
  const scope = new ContextScope([
    ...captureSessionContext(),
    ...captureRecordingContext(),
    captureCacheContext(),
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
