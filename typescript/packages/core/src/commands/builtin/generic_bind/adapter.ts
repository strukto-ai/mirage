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

import type {
  ReadOps,
  NativeReadOps,
  WriteOps,
  SearchOps,
  ReadStreamOp,
  ReaddirOp,
  ResolveGlobOp,
  StatOp,
} from '../../../vfs/types.ts'

import type { Accessor } from '../../../accessor/base.ts'
import {
  requirePathsWritable,
  getAdmission,
  getCurrentSession,
  getOpPolicies,
  hiddenPathsIntersect,
  hiddenRefusal,
  liveSessions,
  mountGateFor,
  pathAllowed,
} from '../../../context/session_context.ts'
import { preOpsGate, type Policies } from '../../../policy/policies.ts'
import { hasAborted, makeAbortError } from '../../../workspace/abort.ts'
import { moveReveals } from '../../../utils/hidden.ts'
import { removeRemnants, visibleBelow, type RemnantChannel } from '../../../utils/remnants.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import type { StatOverlay } from '../../../ops/types.ts'

import { FileType, PathSpec, type FileStat } from '../../../types.ts'
import { eacces, eisdir, enotsup, isMissError } from '../../../utils/errors.ts'
import type { ChildMounts } from '../../../ops/types.ts'
import {
  DEFAULT_MAX_GLOB_MATCHES,
  resolveGlobWith,
  type TargetStat,
} from '../../../utils/glob_walk.ts'
import { norm, parent } from '../../../utils/path.ts'
import { stripSlash } from '../../../utils/slash.ts'

import type { AggregateFn, CommandFnResult, CommandOpts, ProvisionFn } from '../../config.ts'

export function makeResolveGlob<A extends Accessor = Accessor>(
  readdir: ReaddirOp<A>,
  maxGlobMatches: number = DEFAULT_MAX_GLOB_MATCHES,
  children?: ChildMounts,
  stat?: StatOp<A>,
  targetStat?: TargetStat,
): ResolveGlobOp<A> {
  return async (accessor, paths, index) =>
    resolveGlobWith(readdir, accessor, paths, index, maxGlobMatches, children, stat, targetStat)
}

export interface CommandIO<A extends Accessor = Accessor>
  extends ReadOps<A>, NativeReadOps<A>, WriteOps<A> {
  readStream: ReadStreamOp<A>
  isMounted: (accessor: A) => boolean
  streamsBytes?: boolean
  local?: boolean
  maxGlobMatches?: number
  maxDuEntries?: number
  // Child names the namespace owes a directory (nested mount roots and
  // symlinks). Stamped per invocation from opts.childMounts by the
  // factory, because it is session-scoped state while the adapter itself
  // is built once per backend.
  search?: SearchOps<A>
  globChildren?: ChildMounts
  // What an owed name points at, the namespace's own stat resolved
  // through the workspace. Stamped beside globChildren from opts.ns.links,
  // so a trailing-slash glob follows a link the way bash does instead of
  // keeping every link it cannot see through.
  globTargetStat?: TargetStat
}

export function resolveGlobOf<A extends Accessor = Accessor>(ops: CommandIO<A>): ResolveGlobOp<A> {
  return makeResolveGlob(
    ops.readdir,
    ops.maxGlobMatches,
    ops.globChildren,
    ops.stat,
    ops.globTargetStat,
  )
}

/** Refuse a hidden path the way nonexistence would: ENOENT for anything
 * acting on the path; a create answers as `hiddenRefusal` says, EACCES
 * only when the directory it lands in is visible. Raised at the op
 * boundary so each command renders the refusal through its own
 * missing-file wording, indistinguishable from a real miss. */
function refuseHidden(path: PathSpec, create: boolean): void {
  if (pathAllowed(path.virtual)) return
  throw hiddenRefusal(path.virtual, create)
}

function visibleChildren(entries: string[], parent: PathSpec): string[] {
  const base = parent.virtual.replace(/\/+$/, '')
  return entries.filter((e) => {
    const trimmed = e.replace(/\/+$/, '')
    return pathAllowed(`${base}/${trimmed.slice(trimmed.lastIndexOf('/') + 1)}`)
  })
}

/** Whether any live session's hides make this relocation a reveal. */
function moveWouldReveal(src: PathSpec, dst: PathSpec): boolean {
  return liveSessions().some((sess) =>
    moveReveals(sess.hiddenPaths, sess.shownPaths, src.virtual, dst.virtual),
  )
}

/** Refuse a relocation that would surface a hidden path.
 *
 * A rename or a native directory copy re-anchors everything below its
 * source, and a hide's coverage does not move with the content, so
 * hidden bytes would land at paths the session can see. EACCES on the
 * source, which mv and cp render in GNU's permission-denied voice.
 * Only a directory has anything below it to re-anchor, so callers
 * check this for a source they know is a directory and skip it for a
 * file. */
export function refuseReveal(src: PathSpec, dst: PathSpec): void {
  if (moveWouldReveal(src, dst)) throw eacces(src.virtual)
}

/** Whether a pair op's source stats as a directory, probed only when
 * the reveal check trips: an absent source moves nothing (the op
 * itself reports it), and an unanswerable one fails toward refusal. */
async function pairSrcIsDir<A extends Accessor>(
  stat: StatOp<A>,
  accessor: A,
  src: PathSpec,
): Promise<boolean> {
  let row: FileStat
  try {
    row = await stat(accessor, src, undefined)
  } catch (err) {
    if (isMissError(err)) return false
    return true
  }
  return row.type === FileType.DIRECTORY
}

/**
 * Return `ops` whose slots refuse hidden paths like missing ones.
 *
 * The commands factory hands this copy to every generic command, the
 * same shape as `withReadCache`, so hidden-path enforcement lands once
 * for the whole command tier (resolveGlobOf derives from the wrapped
 * readdir). The backends' own IO constants stay raw: the ops tables
 * built from them serve the dispatcher, which enforces hiding itself
 * at the door. The guards read the current session at call time, so
 * one wrapped copy is shared across sessions.
 */
export function withHiddenGuard<A extends Accessor = Accessor>(ops: CommandIO<A>): CommandIO<A> {
  const guarded: CommandIO<A> = {
    ...ops,
    readdir: async (accessor, path, index) => {
      refuseHidden(path, false)
      return visibleChildren(await ops.readdir(accessor, path, index), path)
    },
  }
  const slots = ['readBytes', 'readStream', 'stat', 'readRange', 'find', ...mutationSlots] as const
  for (const slot of slots) {
    if (slot === 'rename' || slot === 'dirCopy' || slot === 'rmdir') continue
    guardSlot(ops, guarded, slot, (paths) => {
      hiddenCheck(paths, mutationOf(slot)?.create)
    })
  }
  const ex = ops.exists
  if (ex !== undefined) {
    guarded.exists = async (accessor, path) => {
      if (!pathAllowed(path.virtual)) return false
      return ex(accessor, path)
    }
  }
  const rd = ops.rmdir
  if (rd !== undefined) {
    // The backend refuses a directory still holding entries, but when
    // every remaining entry is hidden the refusal would leak that
    // something invisible exists, so the remnants go with the
    // directory: a session's mutation may destroy what it cannot see,
    // never learn of it. Any visible child keeps the refusal, and a
    // backend with no unlink keeps it too, having no way to take the
    // remnants. The removal is the shared removeRemnants walk over the
    // sibling slots, which revalidates visibility before every
    // deletion and keeps the mode guard on each one; any cascade
    // failure answers with the backend's original refusal, exactly as
    // the ops plane does.
    const rawReaddir = ops.readdir
    const rawStat = ops.stat
    const rawUnlink = ops.unlink
    // Captured at wrap time, which holds the invocation's fact because
    // the factory applies this guard per invocation, after stamping it.
    const children = ops.globChildren
    guarded.rmdir = async (accessor, path, index) => {
      refuseHidden(path, false)
      try {
        await rd(accessor, path, index)
        return
      } catch (exc) {
        const code = (exc as { code?: string }).code
        if (
          rawUnlink === undefined ||
          (code !== 'ENOTEMPTY' && code !== 'EEXIST') ||
          !hiddenPathsIntersect(path.virtual)
        ) {
          throw exc
        }
        // The fallback listing folds into the refusal exactly as the
        // cascade below does: a backend that cannot list the remnants
        // keeps the original refusal, whatever error type it failed
        // with, because a raw backend failure here would reveal
        // exactly what the refusal exists to hide.
        let entries: string[]
        try {
          entries = await rawReaddir(accessor, path, index)
        } catch {
          throw exc
        }
        // The namespace children join the emptiness judgment, never
        // the walk: a visible mounted child keeps the refusal exactly
        // as the ops plane's merged listing does, while the cascade
        // itself only ever removes what the backend holds.
        const merged = children === undefined ? entries : [...entries, ...children(path.virtual)]
        if (entries.length === 0 || visibleBelow(path.virtual, merged, pathAllowed)) {
          throw exc
        }
        const channel: RemnantChannel = {
          readdir: (at) => rawReaddir(accessor, at, index),
          stat: (at) => rawStat(accessor, at, index),
          unlink: (at) => rawUnlink(accessor, at),
          rmdir: (at) => rd(accessor, at, index),
        }
        try {
          await removeRemnants(channel, pathAllowed, path)
        } catch {
          throw exc
        }
      }
    }
  }
  const rn = ops.rename
  if (rn !== undefined) {
    // Only a directory source can carry hidden content into view, so a
    // rename whose source stats as a file passes the reveal check.
    guarded.rename = async (accessor, src, dst) => {
      refuseHidden(src, false)
      refuseHidden(dst, true)
      if (moveWouldReveal(src, dst) && (await pairSrcIsDir(ops.stat, accessor, src))) {
        throw eacces(src.virtual)
      }
      return rn(accessor, src, dst)
    }
  }
  const dc = ops.dirCopy
  if (dc !== undefined) {
    guarded.dirCopy = (accessor, src, dst) => {
      refuseHidden(src, false)
      refuseHidden(dst, true)
      refuseReveal(src, dst)
      return dc(accessor, src, dst)
    }
  }
  return guarded
}

/** Ask the admitted command's gate about each path before a backend op
 * runs (a rename or copy has two, and a refused destination is as much a
 * refusal as a refused source). The gate throws at call time and the op's
 * own return shape passes through untouched; with no gate bound (no
 * admitted command in this context) the op runs as is. */
function ruleCheck(...paths: readonly PathSpec[]): void {
  const gate = getAdmission()
  if (gate === null) return
  for (const path of paths) gate.check(path.virtual)
}

interface Mutation {
  create?: boolean
  firstSource?: boolean
  subtree?: boolean
}

const MUTATIONS = {
  write: { create: true },
  mkdir: { create: true },
  append: { create: true },
  create: { create: true },
  truncate: { create: true },
  unlink: {},
  rmdir: {},
  setAttrs: {},
  rmR: { subtree: true },
  rename: { subtree: true },
  copy: { firstSource: true },
  dirCopy: { firstSource: true, subtree: true },
} satisfies Partial<Record<keyof CommandIO, Mutation>>

type MutationSlot = keyof typeof MUTATIONS
const mutationSlots = Object.keys(MUTATIONS) as MutationSlot[]
const contentSlots = ['readBytes', 'readRange', 'readStream', 'readdir'] as const
type GuardedSlot = MutationSlot | (typeof contentSlots)[number]

function mutationOf(slot: string): Mutation | undefined {
  return Object.hasOwn(MUTATIONS, slot) ? MUTATIONS[slot as MutationSlot] : undefined
}

function pathsOf(args: readonly unknown[]): PathSpec[] {
  return args.filter((arg): arg is PathSpec => arg instanceof PathSpec)
}

/** Preserve each slot's arguments and return shape, including synchronous streams. */
function guardSlot<A extends Accessor>(
  ops: CommandIO<A>,
  guarded: CommandIO<A>,
  slot: GuardedSlot | 'stat' | 'find',
  check: (paths: PathSpec[]) => void,
): void {
  const fn = ops[slot]
  if (fn === undefined) return
  Object.assign(guarded, {
    [slot]: (...args: never[]) => {
      check(pathsOf(args))
      return (fn as (...values: never[]) => unknown)(...args)
    },
  })
}

/**
 * Return `ops` whose content and mutation slots ask the admitted
 * command's gate before touching a path.
 *
 * The rule arms' counterpart of `withHiddenGuard`, wrapped inside it so
 * a hidden path still answers ENOENT before any rule can name it. The
 * gate judged the line's operands; this is how a walk (`grep -r`, `find`,
 * `du`, `cp -r`, `tar`) is held to the same rules on the entries it
 * reaches below them. `stat` and `exists` stay unguarded, because deny
 * means present and refused, not absent: a listing shows a refused
 * entry's name and size, and the read of it is what fails, as GNU reports
 * an unreadable file. `readdir` asks about the directory being listed,
 * never filters its names. A backend's native `find`/`du` are not
 * wrapped: the builders route to the readdir walk while a path rule
 * scopes the command (`pathRulesActive`), so every entry passes through
 * here.
 */
export function withRuleGuard<A extends Accessor = Accessor>(ops: CommandIO<A>): CommandIO<A> {
  const guarded = { ...ops }
  for (const slot of [...contentSlots, ...mutationSlots]) {
    guardSlot(ops, guarded, slot, (paths) => {
      ruleCheck(...paths)
    })
  }
  return guarded
}

/** Resolve the governing mount per path, including on fallback context storage. */
function modeCheck(written: readonly PathSpec[], subtree = false): void {
  for (const spec of written) {
    const gate = mountGateFor(spec.virtual)
    if (gate !== null) requirePathsWritable([spec], ...gate)
  }
  if (subtree) {
    for (const spec of written) {
      const gate = mountGateFor(spec.virtual)
      if (gate !== null) requirePathsWritable([spec], ...gate, true)
    }
  }
}

/** Guard only written endpoints; native subtree mutations also check descendants. */
export function withModeGuard<A extends Accessor = Accessor>(ops: CommandIO<A>): CommandIO<A> {
  const guarded = { ...ops }
  for (const slot of mutationSlots) {
    const access: Mutation = MUTATIONS[slot]
    guardSlot(ops, guarded, slot, (paths) => {
      modeCheck(access.firstSource ? paths.slice(1) : paths, access.subtree)
    })
  }
  return guarded
}

/**
 * Return `ops` under the whole path axis: hides answer ENOENT first,
 * rules refuse next, the mode speaks last.
 *
 * The one spelling of the guard chain, used by the commands factory
 * for every generic command and by a bespoke command family that
 * consumes a `CommandIO` directly (the object-store overrides), so an
 * override enforces the session's path axis exactly like the generic
 * it replaces.
 */
export function withPathGuards<A extends Accessor = Accessor>(ops: CommandIO<A>): CommandIO<A> {
  return withHiddenGuard(withRuleGuard(withModeGuard(ops)))
}

/** The policies to consult for one slot call, with the mount prefix
 * and session identity the call belongs to. */
interface OpPolicyScope {
  policies: Policies
  /** The wrap site's mount prefix; null resolves per path at admit
   * time (a registration-time wrap has no one mount). */
  prefix: string | null
  sessionId: string
}

/**
 * The scope to consult for this op call: null is the fast path (no
 * dispatched command bound policies, or none of them override preOps).
 */
function opPolicyScope(prefix: string | null): OpPolicyScope | null {
  const policies = getOpPolicies()
  if (!policies?.wants('preOps')) return null
  return { policies, prefix, sessionId: getCurrentSession()?.sessionId ?? '' }
}

/**
 * The wrap-time scope when it caught a bound command, else the
 * call-time context.
 *
 * The factory applies the guard inside the command's window, so its
 * wrap-time capture also covers a reader the output pipeline drains
 * after dispatch has reset the context (head/tail/wc bind lazy
 * readers), with the prefix and session identity the drained op
 * belongs to; a registration-time wrap (the object-store overrides,
 * the loose-write chain) has no window when applied and reads the
 * live context instead, which its eager handlers are inside.
 */
function livePolicyScope(scope: OpPolicyScope | null): OpPolicyScope | null {
  return scope ?? opPolicyScope(null)
}

/** Fire preOps for one PathSpec of one slot call; the op is the slot
 * name in its shared snake spelling, so a policy portable across the
 * languages and tiers sees one vocabulary. */
async function policyAdmit(
  scope: OpPolicyScope,
  op: string,
  path: PathSpec,
  write: boolean,
): Promise<void> {
  const prefix = scope.prefix ?? mountGateFor(path.virtual)?.[0] ?? ''
  await preOpsGate(scope.policies, op, path, write, prefix, scope.sessionId)
}

/** Drain `source` once the read is admitted, before any byte is
 * pulled; the inner iterable was built eagerly by the caller. */
async function* policyStream(
  scope: OpPolicyScope,
  path: PathSpec,
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  await policyAdmit(scope, 'read_stream', path, false)
  yield* source
}

/**
 * Return `ops` whose content and mutation slots admit each PathSpec
 * through the workspace's coded preOps hooks.
 *
 * The coded-policy arm of the guard chain, applied outside the cache
 * wraps so admission fires before a warm serve, the dispatcher's own
 * order. The surface is the rule guard's plus readdir: content reads
 * (readBytes, readStream, readRange), every mutation slot, and the
 * directory a readdir lists. stat/exists and the native find/du slots
 * stay unguarded as presence facts, the mode-000 shape the rule guard
 * already states, so a denied entry still lists and stats while the
 * read of it is what fails. Inert unless a dispatched command bound
 * policies overriding preOps (`opPolicyScope`, with the mount prefix
 * and session identity captured at wrap time so a lazily drained
 * reader still answers as the command that bound it, see
 * `livePolicyScope`; `prefix` arrives from the wrap site because the
 * fallback mount-gate storage resolves by path, which a drained
 * reader no longer has a live gate for).
 */
export function withPolicyGuard<A extends Accessor = Accessor>(
  ops: CommandIO<A>,
  prefix?: string,
): CommandIO<A> {
  const scope = opPolicyScope(prefix ?? null)
  const guarded: CommandIO<A> = {
    ...ops,
    readStream: (accessor, path, index) => {
      const p = livePolicyScope(scope)
      const inner = ops.readStream(accessor, path, index)
      if (p === null) return inner
      return policyStream(p, path, inner)
    },
  }
  for (const slot of ['readBytes', 'readRange', 'readdir', ...mutationSlots] as const) {
    const fn = ops[slot]
    if (fn !== undefined) {
      // All slots in this set return promises; readStream keeps its own wrapper.
      Object.assign(guarded, { [slot]: policyCall(scope, fn, slot) })
    }
  }
  return guarded
}

function policyCall<T extends (...args: never[]) => unknown>(
  scope: OpPolicyScope | null,
  fn: T,
  slot: GuardedSlot,
): T {
  return (async (...args: never[]) => {
    const p = livePolicyScope(scope)
    if (p !== null) {
      const access = mutationOf(slot)
      const paths = pathsOf(args)
      const name = slot.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
      for (const [i, path] of paths.entries()) {
        await policyAdmit(p, name, path, access !== undefined && !(i === 0 && access.firstSource))
      }
    }
    return fn(...args)
  }) as T
}

/** `fn`, refused with the line's abort instead of started once `signal` has fired. */
function refusedAfterAbort<T extends unknown[], R>(
  signal: AbortSignal,
  fn: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  return (...args) => (hasAborted(signal) ? Promise.reject(makeAbortError(signal)) : fn(...args))
}

/**
 * Return `ops` whose backend slots refuse to start once the invocation's
 * signal has fired.
 *
 * The twin of the dispatch door's guard for mount commands: a handler
 * that loops over operands (`rm a b`, `cp -r`, `mkdir -p`) awaits a slot
 * once per operand, and a JS promise cannot be cancelled, so after the
 * caller was released the handler resumes on the await that was in
 * flight and would begin the next read or write. Refusing at the slot,
 * the one seam every generic-bound handler's I/O goes through, stops it
 * there without each handler reading the signal. A slot already in
 * flight settles on its own, and `readStream` is left alone because the
 * reader it returns is guarded as it is drained (`guardInput`). The
 * presence facts (stat, exists, find, du) are refused too. They cost no
 * write, which is why the policy guard leaves them, but each one is a
 * request on an API-backed mount: `stat a b` whose first call outlives
 * the grace would start the second after the caller was released. The
 * promise is no further read *or* write between operands, so a read
 * that happens to answer a question rather than return bytes is still
 * a read. Python needs nothing here: its cancelled task never reaches
 * the next operand.
 */
export function withAbortGuard<A extends Accessor = Accessor>(
  ops: CommandIO<A>,
  signal: AbortSignal | undefined,
): CommandIO<A> {
  if (signal === undefined) return ops
  const guarded: CommandIO<A> = {
    ...ops,
    readdir: refusedAfterAbort(signal, ops.readdir),
    readBytes: refusedAfterAbort(signal, ops.readBytes),
    stat: refusedAfterAbort(signal, ops.stat),
  }
  if (ops.readRange !== undefined) guarded.readRange = refusedAfterAbort(signal, ops.readRange)
  if (ops.exists !== undefined) guarded.exists = refusedAfterAbort(signal, ops.exists)
  if (ops.find !== undefined) guarded.find = refusedAfterAbort(signal, ops.find)
  if (ops.du !== undefined) {
    guarded.du = {
      size: refusedAfterAbort(signal, ops.du.size),
      entries: refusedAfterAbort(signal, ops.du.entries),
    }
  }
  if (ops.write !== undefined) guarded.write = refusedAfterAbort(signal, ops.write)
  if (ops.mkdir !== undefined) guarded.mkdir = refusedAfterAbort(signal, ops.mkdir)
  if (ops.append !== undefined) guarded.append = refusedAfterAbort(signal, ops.append)
  if (ops.create !== undefined) guarded.create = refusedAfterAbort(signal, ops.create)
  if (ops.unlink !== undefined) guarded.unlink = refusedAfterAbort(signal, ops.unlink)
  if (ops.rmdir !== undefined) guarded.rmdir = refusedAfterAbort(signal, ops.rmdir)
  if (ops.rmR !== undefined) guarded.rmR = refusedAfterAbort(signal, ops.rmR)
  if (ops.truncate !== undefined) guarded.truncate = refusedAfterAbort(signal, ops.truncate)
  if (ops.rename !== undefined) guarded.rename = refusedAfterAbort(signal, ops.rename)
  if (ops.copy !== undefined) guarded.copy = refusedAfterAbort(signal, ops.copy)
  if (ops.dirCopy !== undefined) guarded.dirCopy = refusedAfterAbort(signal, ops.dirCopy)
  const sa = ops.setAttrs
  if (sa !== undefined) {
    guarded.setAttrs = (accessor: A, path: PathSpec, ...rest: unknown[]) => {
      if (hasAborted(signal)) throw makeAbortError(signal)
      return sa(accessor, path, ...rest)
    }
  }
  return guarded
}

/**
 * Guard one bare backend write the way the adapter guards a slot.
 *
 * For a bespoke command wired from loose functions rather than a
 * `CommandIO` (the google `rm` family binds an index-threaded unlink):
 * the same chain in the same order, judging the written path. A hidden
 * path answers ENOENT, the flavor of the flat mutation slots. The
 * policy arm rides outermost, as it does on the slot chain, and reads
 * the live context (this wrap happens at registration, its handlers
 * are eager).
 */
export function withWriteGuards<A extends Accessor, R>(
  fn: (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<R> | R,
): (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<R> {
  return guardOperation(fn, 'unlink')
}

/**
 * A `readRange` slot built from a backend read that already takes a byte
 * window as its options argument.
 *
 * Without the slot the ops factory reads the whole object and slices, so
 * `head -c 100` on a 2 GiB S3 key downloads 2 GiB. Python has pushed the
 * window down on every one of these backends since the slot existed by
 * pointing `read_range` at its own `read_bytes`; this is the same move,
 * spelled for a read whose window arrives in an options object.
 *
 * Args:
 *   read: the backend's whole-file read, whose fourth argument is an
 *     `{offset?, size?}` window.
 */
export function rangeOf<A extends Accessor = Accessor>(
  read: (
    accessor: A,
    path: PathSpec,
    index: IndexCacheStore | undefined,
    options: { offset?: number; size?: number },
  ) => Promise<Uint8Array>,
): NonNullable<CommandIO<A>['readRange']> {
  return (accessor, path, index, offset, size) =>
    read(accessor, path, index, size === null ? { offset } : { offset, size })
}

// Whether a path that failed with ENOENT is an implicit directory. Keyed
// backends (RAM/Redis/S3) have no directory entries: stat/read of a prefix
// that only exists through deeper keys raises ENOENT. The operand's own
// readdir cannot serve as the probe: synthetic hierarchies fabricate
// children for any name (postgres answers tables/views for a missing
// schema) and database backends raise driver errors for missing tables.
// The parent listing is authoritative instead: the operand is an implicit
// directory only if its parent's readdir lists it. When the operand is the
// mount root there is no parent to list, so its own readdir decides (root
// listings are real in every backend). Any probe failure is a negative
// probe (the original ENOENT stands), never an error to surface.
async function isImplicitDir<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<boolean> {
  const target = norm(path.virtual)
  const key = stripSlash(path.vfsPath)
  if (!key) {
    try {
      const entries = await ops.readdir(accessor, path, index)
      return entries.length > 0
    } catch {
      return false
    }
  }
  const parentKey = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''
  const parentVirtual = parent(target)
  const parentPath = new PathSpec({
    virtual: parentVirtual,
    directory: parentVirtual,
    vfsPath: parentKey,
  })
  try {
    const entries = await ops.readdir(accessor, parentPath, index)
    return entries.some((entry) => norm(entry) === target)
  } catch {
    return false
  }
}

// Whether a path no backend knows is a directory the namespace owns: the
// third way a read operand can be a directory, after the explicit stat row
// and the implicit keyed-backend prefix. A directory that exists only
// because a mount or a link sits under it (`/repos` when `/repos/alpha` is
// mounted) belongs to no backend at all, so the mount this command is bound
// to can neither stat it nor list it, and every read command reported it
// missing while stat, file, ls, du, find and tree all called it a directory.
//
// The names the namespace owes the path, not a dispatched stat. Both answer
// for a mount parent, but a dispatched stat also answers from a backend's own
// listing, and a backend that answers a path it does not hold with entries
// rather than a miss turns every such path into a directory: postgres reads
// any first segment as a schema and lists `tables` and `views` under it, so
// `cat /pg/nope.txt` refused a directory that is not there. The namespace
// cannot over-claim that way, because it derives a segment only from a mount
// prefix or a link path it actually holds, and it is the same authority
// `namespaceListing` gates on, so the listing and this refusal cannot
// disagree. It is hide-filtered for free, which is what keeps the parent of a
// mount the session may not be told about reading as absence.
function isNamespaceDir(opts: CommandOpts, p: PathSpec): boolean {
  const children = opts.ns?.childMounts
  if (children === undefined) return false
  return children(p.virtual).length > 0
}

// The one place the read family decides what a directory is, shared by the
// stat and the stream chokepoints so the two cannot drift.
async function statRefusingDirs<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  opts: CommandOpts,
  p: PathSpec,
): Promise<FileStat> {
  const index = opts.index ?? undefined
  let st: FileStat
  try {
    st = await ops.stat(accessor, p, index)
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e
    if (await isImplicitDir(ops, accessor, p, index)) throw eisdir(p)
    if (isNamespaceDir(opts, p)) throw eisdir(p)
    throw e
  }
  if (st.type === FileType.DIRECTORY) throw eisdir(p)
  return st
}

// Stat for the read-family chokepoint (`splitReadable`): a directory operand
// fails with EISDIR instead of succeeding (explicit, via the stat type) or
// failing with ENOENT (implicit keyed-backend directory via a readdir probe,
// or a namespace-only mount parent via the name plane), so cat/head/tail
// report GNU's `Is a directory` and keep the remaining operands (#457).
//
// Takes the whole `opts` rather than its index because this is where every
// read command decides what a directory is, and the facts that answer that
// question arrive on the bag: threading them one at a time would mean
// editing every one of the two dozen builders again for the next one.
export function dirAwareStat<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  opts: CommandOpts,
): (p: PathSpec) => Promise<FileStat> {
  return (p) => statRefusingDirs(ops, accessor, opts, p)
}

// Stat through the backend, then merge the namespace attr overlay, so the
// stat-rendering commands (ls -l, stat -c) show the chmod/chown/touch state a
// backend without an attribute slot cannot hold itself. Returns the plain stat
// unchanged when the executor injected no overlay. Mirrors the Python
// `overlaid_stat`; every stat-rendering command binds through here so no
// backend can quietly skip the merge and disagree with the ops facade.
export function overlaidStat(
  stat: (p: PathSpec) => Promise<FileStat>,
  overlay: StatOverlay | undefined,
): (p: PathSpec) => Promise<FileStat> {
  if (overlay === undefined) return stat
  return async (p) => overlay(p.virtual, await stat(p))
}

function hiddenCheck(paths: readonly PathSpec[], create = false): void {
  for (const [i, path] of paths.entries()) refuseHidden(path, i > 0 || create)
}

/** Guard a bare operation or capability fallback using the slot contract. */
function guardOperation<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R> | R,
  name: MutationSlot | 'exists',
): (...args: Args) => Promise<R> {
  const access = mutationOf(name)
  const guarded = async (...args: Args): Promise<R> => {
    const specs = pathsOf(args)
    hiddenCheck(specs, access?.create)
    if (access !== undefined) {
      ruleCheck(...specs)
      modeCheck(access.firstSource ? specs.slice(1) : specs, access.subtree)
    }
    return fn(...args)
  }
  return name === 'exists' ? guarded : policyCall(opPolicyScope(null), guarded, name)
}

/** Require a capability at call time, after the same guards as an available op. */
export function requireOp<T extends (...args: never[]) => Promise<unknown>>(
  op: T | undefined,
  name: MutationSlot | 'exists',
): T {
  if (op !== undefined) return op
  const refuse = (...args: never[]): Promise<never> => {
    const specs = pathsOf(args)
    const named = mutationOf(name)?.firstSource ? specs[1] : specs[0]
    return Promise.reject(
      enotsup(
        'backend',
        name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        named ?? '',
      ),
    )
  }
  return guardOperation(refuse, name) as unknown as T
}

/**
 * Whether a read that already failed was really a read of a directory.
 *
 * Asked only after the read threw, which is what keeps a successful read
 * at exactly one backend call. Nothing is lost by waiting: every backend
 * throws on a directory read. One that knows says so (gdrive, box,
 * dropbox and disk throw EISDIR), a keyed store answers ENOENT because a
 * directory there is a set of keys rather than an object, and sftp
 * answers with an error carrying no errno at all.
 *
 * Four ways the answer can be yes, in probe-cost order. The code itself
 * costs nothing. The stat is one call, and a stat that ANSWERS ends the
 * cascade either way: a file is a file, and the later probes only make
 * sense for a path stat could not see. Reaching past a successful stat
 * read a rule-refused file as a directory, because its parent's listing
 * names it. The parent listing is one call and is the only thing that can
 * tell a missing key from a prefix that exists only through deeper keys.
 * The namespace's child names cost nothing and are the only authority for
 * a directory that exists because a mount or a link sits under it, which
 * no backend can see because those keys live in another VFS.
 *
 * A no leaves the original error untouched, so nothing is swallowed: the
 * caller rethrows what the backend said. Both probes are broad for that
 * same reason, which is the one `isImplicitDir` states for its own
 * catches: a probe that fails is a negative probe, never an error to
 * surface. Surfacing one would replace the read's error with one from a
 * call the user never made, and it is the read that failed.
 */
async function readHitADir<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  err: unknown,
): Promise<boolean> {
  if ((err as { code?: string }).code === 'EISDIR') return true
  let st: FileStat | null = null
  try {
    st = await ops.stat(accessor, path, index)
  } catch {
    st = null
  }
  if (st !== null) return st.type === FileType.DIRECTORY
  try {
    if (await isImplicitDir(ops, accessor, path, index)) return true
  } catch {
    // negative probe, see above
  }
  // The same fact isNamespaceDir reads, reached from the adapter rather
  // than from the bag: this guard wraps a slot and never sees a
  // CommandOpts, and the factory stamps the very callable
  // opts.ns.childMounts would hand over.
  return ops.globChildren !== undefined && ops.globChildren(path.virtual).length > 0
}

async function* drainRefusingDirs<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  try {
    yield* source
  } catch (err) {
    if (await readHitADir(ops, accessor, path, index, err)) throw eisdir(path)
    throw err
  }
}

/**
 * Return `ops` whose reads refuse a directory with GNU's EISDIR.
 *
 * The read family's counterpart of `withHiddenGuard` and
 * `withSlashGuard`: reading a directory is never a legitimate call, so
 * the refusal belongs to the slot rather than to each builder's wiring.
 * It used to belong to the wiring, and 23 of the read builders passed the
 * raw `ops.readStream` instead, so a directory on a keyed backend
 * reported ENOENT.
 *
 * Refined after the failure, never before it, so a read that succeeds
 * costs exactly what it did. The refusal is built from the operand's own
 * PathSpec, so it carries the virtual path: a raw disk error names the
 * host path, which is the mount's own business and must not reach a
 * user-facing line.
 *
 * Mirrors the Python `with_dir_guard`.
 */
export function withDirGuard<A extends Accessor = Accessor>(ops: CommandIO<A>): CommandIO<A> {
  const guarded: CommandIO<A> = {
    ...ops,
    readBytes: async (accessor, path, index) => {
      try {
        return await ops.readBytes(accessor, path, index)
      } catch (err) {
        if (await readHitADir(ops, accessor, path, index, err)) throw eisdir(path)
        throw err
      }
    },
    // The wrapped op is called HERE, not inside the generator: the
    // read-through cache reads the active CacheManager when the slot is
    // called, and deferring that to drain time loses the mount's
    // cache-manager scope, so every warm read missed.
    readStream: (accessor, path, index) =>
      drainRefusingDirs(ops, accessor, path, index, ops.readStream(accessor, path, index)),
  }
  const readRange = ops.readRange
  if (readRange !== undefined) {
    guarded.readRange = async (accessor, path, index, offset, size) => {
      try {
        return await readRange(accessor, path, index, offset, size)
      } catch (err) {
        if (await readHitADir(ops, accessor, path, index, err)) throw eisdir(path)
        throw err
      }
    }
  }
  return guarded
}

async function* streamRefusingDirs<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  opts: CommandOpts,
  p: PathSpec,
): AsyncIterable<Uint8Array> {
  await statRefusingDirs(ops, accessor, opts, p)
  yield* ops.readStream(accessor, p, opts.index ?? undefined)
}

// Read stream for the read-family per-operand chokepoint (`readOperands`):
// the operand is stat'ed first so a directory fails with EISDIR before any
// backend read runs (sftp reads of a directory raise an opaque `Failure`,
// not ENOENT), and an ENOENT for an implicit keyed-backend directory or a
// namespace-only mount parent is refined the same way `dirAwareStat` does,
// before the generic formats the stderr line (#457). Mirrors the Python
// `dir_aware_stream`.
export function dirAwareStream<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  opts: CommandOpts,
): (p: PathSpec) => AsyncIterable<Uint8Array> {
  return (p) => streamRefusingDirs(ops, accessor, opts, p)
}

export type BuilderFn<A extends Accessor = Accessor> = (
  ops: CommandIO<A>,
  accessor: A,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
) => Promise<CommandFnResult> | CommandFnResult

export interface Builder<A extends Accessor = Accessor> {
  name: string
  fn: BuilderFn<A>
  provision?: (stat: StatOp<A>) => ProvisionFn<A>
  write?: boolean
  aggregate?: AggregateFn
  read?: boolean
}
