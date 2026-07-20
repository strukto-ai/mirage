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

import { mountKey } from '../../utils/key_prefix.ts'
import { type Accessor, NOOPAccessor } from '../../accessor/base.ts'
import type {
  CommandDispatch,
  CommandFn,
  CommandOpts,
  RegisteredCommand,
} from '../../commands/config.ts'
import type { OpKwargs } from '../../ops/registry.ts'
import type { StatOverlay } from '../../ops/config.ts'

const NOOP_ACCESSOR = new NOOPAccessor()
import { getExtension } from '../../commands/resolve.ts'
import { resolveSafeguard } from '../../commands/safeguard.ts'
import { applyOpSafeguard, runWithTimeout } from '../../commands/builtin/utils/safeguard.ts'
import type { CommandSpec } from '../../commands/spec/types.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult } from '../../io/types.ts'
import { runWithCacheManager } from '../../cache/context.ts'
import type { CacheManager } from '../../cache/manager.ts'
import { runWithRevisions, setVirtualPrefix } from '../../observe/context.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import type { Resource } from '../../resource/base.ts'
import { type CommandSafeguard, ConsistencyPolicy, MountMode, PathSpec } from '../../types.ts'
import type { Runtime } from '../executor/runtime.ts'
import { eaccesReadOnly, enotsup } from '../../utils/errors.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { effectiveMountMode } from '../../context/session_context.ts'

type CmdKey = string
type OpKey = string

function cmdKey(name: string, filetype: string | null): CmdKey {
  return `${name}\u0000${filetype ?? ''}`
}

function isRegisteredOp(item: RegisteredCommand | RegisteredOp): item is RegisteredOp {
  return typeof (item as RegisteredOp).fn === 'function' && !('spec' in item)
}

function opKey(name: string, filetype: string | null): OpKey {
  return `${name}\u0000${filetype ?? ''}`
}

function crossKey(name: string, targetResource: string): string {
  return `${name}\u0000${targetResource}`
}

export interface MountInit {
  prefix: string
  resource: Resource
  mode?: MountMode
  consistency?: ConsistencyPolicy
}

export class MountEntry {
  readonly prefix: string
  readonly resource: Resource
  readonly mode: MountMode
  readonly consistency: ConsistencyPolicy

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
  readonly commandSafeguards = new Map<string, CommandSafeguard>()
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
    this.resource = init.resource
    this.mode = init.mode ?? MountMode.READ
    this.consistency = init.consistency ?? ConsistencyPolicy.LAZY
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
    const byResource = this.cmds.get(cmdKey(cmdName, null))
    if (byResource !== undefined) return byResource
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
    const fns: Record<string, CommandFn> = {}
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
   * `RegisteredOp`; commands with `resource: null` go to the general
   * table, ops with `resource: null` likewise. Multi-resource entries
   * (sharing the same name across resources) are filtered to this
   * mount's resource kind; if a name has entries but none match this
   * mount, throw.
   */
  registerFns(items: readonly (RegisteredCommand | RegisteredOp)[]): void {
    const kind = this.resource.kind
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
        if (item.resource === null || item.resource === kind) g.toRegister.push(item)
        else g.attempted.add(item.resource)
      } else {
        let g = cmdGroups.get(item.name)
        if (!g) {
          g = { toRegister: [], attempted: new Set() }
          cmdGroups.set(item.name, g)
        }
        if (item.resource === null || item.resource === kind) g.toRegister.push(item)
        else g.attempted.add(item.resource)
      }
    }
    for (const [name, g] of cmdGroups) {
      if (g.toRegister.length === 0) {
        const list = [...g.attempted].sort()
        throw new Error(
          `command '${name}' is for resource(s) [${list.map((r) => `'${r}'`).join(', ')}], not '${kind}'`,
        )
      }
    }
    for (const [name, g] of opGroups) {
      if (g.toRegister.length === 0) {
        const list = [...g.attempted].sort()
        throw new Error(
          `op '${name}' is for resource(s) [${list.map((r) => `'${r}'`).join(', ')}], not '${kind}'`,
        )
      }
    }
    for (const g of cmdGroups.values()) {
      for (const cmd of g.toRegister) {
        if (cmd.resource === null) this.registerGeneral(cmd)
        else this.register(cmd)
      }
    }
    for (const g of opGroups.values()) {
      for (const o of g.toRegister) {
        if (o.resource === null) this.registerGeneralOp(o)
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
    const byResource = table.get(cmdKey(name, null))
    if (byResource !== undefined) levels.push(byResource)
    const generalEntry = general.get(name)
    if (generalEntry !== undefined) levels.push(generalEntry)
    return levels
  }

  // ── execution ─────────────────────────────────────

  async executeCmd(
    cmdName: string,
    paths: PathSpec[],
    texts: string[],
    flags: Record<string, string | boolean | string[]>,
    opts: {
      stdin?: ByteSource | null
      cwd?: string
      dispatch?: CommandDispatch
      sessionId?: string
      env?: Record<string, string>
      execAllowed?: boolean
      runtime?: Runtime
      statOverlay?: StatOverlay
      safeguardOverride?: CommandSafeguard | null
    } = {},
  ): Promise<[ByteSource | null, IOResult]> {
    const extension =
      paths.length > 0 && paths[0] !== undefined ? getExtension(paths[0].virtual) : null

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
          resourcePath: mountKey(p.virtual, mountPrefix),
          rawPath: p.rawPath,
        }),
    )

    const expandedPaths =
      this.resource.glob !== undefined ? await this.resource.glob(prefixedPaths) : prefixedPaths

    const accessor = (this.resource as { accessor?: Accessor }).accessor ?? NOOP_ACCESSOR
    const cmdOpts: CommandOpts = {
      stdin: opts.stdin ?? null,
      flags,
      filetypeFns: isFiletypeCmd ? null : filetypeFns,
      mountPrefix,
      cwd: opts.cwd ?? '/',
      resource: this.resource,
      ...(this.resource.index !== undefined ? { index: this.resource.index } : {}),
      ...(opts.dispatch !== undefined ? { dispatch: opts.dispatch } : {}),
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.execAllowed !== undefined ? { execAllowed: opts.execAllowed } : {}),
      ...(opts.runtime !== undefined ? { runtime: opts.runtime } : {}),
      ...(opts.statOverlay !== undefined ? { statOverlay: opts.statOverlay } : {}),
    }

    setVirtualPrefix(mountPrefix)
    try {
      return await runWithCacheManager(this.cacheManager, () =>
        runWithRevisions(
          this.revisions.size > 0 ? this.revisions : null,
          async (): Promise<[ByteSource | null, IOResult]> => {
            for (const cmd of handlers) {
              if (cmd.write && this.effectiveMode() === MountMode.READ) {
                return [
                  null,
                  new IOResult({
                    exitCode: 1,
                    stderr: new TextEncoder().encode(
                      `${cmdName}: read-only mount at ${this.prefix}`,
                    ),
                  }),
                ]
              }
              // The dispatch-level guard only sees default safeguards
              // (the mount is unknown before routing), so the
              // mount-resolved timeout must also bound the command
              // body: eager commands do their work inside cmd.fn,
              // where the stream-consumption guard never runs.
              const resolvedSafeguard = resolveSafeguard(
                cmdName,
                cmd.safeguard,
                opts.safeguardOverride !== undefined
                  ? opts.safeguardOverride
                  : (this.commandSafeguards.get(cmdName) ?? null),
              )
              const cmdTimeout =
                resolvedSafeguard !== null ? resolvedSafeguard.timeoutSeconds : null
              const result = await runWithTimeout(
                Promise.resolve(cmd.fn(accessor, expandedPaths, texts, cmdOpts)),
                cmdTimeout,
                cmdName,
              )
              if (result !== null) {
                // TODO: hand back a finalization context separately
                // instead of stamping policy onto io.safeguard.
                result[1].safeguard = resolvedSafeguard
                return result
              }
            }
            return [null, new IOResult()]
          },
        ),
      )
    } finally {
      setVirtualPrefix('')
    }
  }

  async executeOp(
    opName: string,
    path: string,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
  ): Promise<unknown> {
    const filetype = getExtension(path)
    const levels = this.resolveCascade(opName, filetype, this.ops, this.generalOps)
    if (levels.length === 0) {
      throw enotsup(this.resource.kind, opName, path)
    }
    if (this.effectiveMode() === MountMode.READ && levels.some((o) => o.write)) {
      throw eaccesReadOnly(`mount ${this.prefix} is read-only`, path)
    }
    const mountPrefix = rstripSlash(this.prefix)
    const lastSlash = path.lastIndexOf('/')
    const scope = new PathSpec({
      virtual: path,
      directory: lastSlash > 0 ? path.slice(0, lastSlash + 1) : '/',
      resourcePath: mountKey(path, mountPrefix),
    })
    const effectiveKwargs: OpKwargs = {
      ...kwargs,
      ...(kwargs.index === undefined && this.resource.index !== undefined
        ? { index: this.resource.index }
        : {}),
      ...(filetype !== null && kwargs.filetype === undefined ? { filetype } : {}),
    }
    const accessor = this.resource.accessor ?? NOOP_ACCESSOR
    const opOverride = this.commandSafeguards.get(opName) ?? null
    const opTimeout = opOverride !== null ? opOverride.timeoutSeconds : null
    return runWithRevisions(this.revisions.size > 0 ? this.revisions : null, async () => {
      for (const op of levels) {
        const result = await runWithTimeout(
          Promise.resolve(op.fn(accessor, scope, args, effectiveKwargs)),
          opTimeout,
          opName,
        )
        if (result !== null && result !== undefined) return applyOpSafeguard(result, opOverride)
      }
      return null
    })
  }
}

function sortFiletypeMap(m: Map<string, (string | null)[]>): Record<string, (string | null)[]> {
  const out: Record<string, (string | null)[]> = {}
  for (const k of [...m.keys()].sort()) {
    const list = m.get(k) ?? []
    list.sort((a, b) => {
      const aKey = a === null ? 0 : 1
      const bKey = b === null ? 0 : 1
      if (aKey !== bKey) return aKey - bKey
      const as = a ?? ''
      const bs = b ?? ''
      return as < bs ? -1 : as > bs ? 1 : 0
    })
    out[k] = list
  }
  return out
}
