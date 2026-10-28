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

import type { Accessor } from '../accessor/base.ts'
import { enotsup, staleWrite } from '../errors/fs.ts'
import type { FsError, StaleWriteError } from '../errors/types.ts'
import { markLost } from '../observe/context.ts'
import type { PathSpec } from '../types.ts'
import { currentCaller, liveCallers, runWithCaller } from '../context/session_context.ts'
import { keyPath, underPath } from '../utils/key_prefix.ts'
import { rstripSlash } from '../utils/slash.ts'
import {
  ANY_WRITE,
  ABSENT_WRITE,
  type ConditionSupport,
  type ReplaceRequest,
  type SettledWrite,
  type CacheContextState,
  type CacheInvalidator,
  type KnownVersions,
  type LiveVersion,
  OwnRead,
  type WriteCondition,
  type WriteContext,
  type WriteKind,
} from './types.ts'

/**
 * Run `fn` with `manager` active for the current async context.
 * Mirrors `runWithRevisions`: the mount entry point wraps command
 * dispatch.
 */
export function runWithCacheManager<T>(
  manager: CacheInvalidator | null,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithCaller({ ...currentCaller(), cache: { manager } }, fn)
}

/**
 * Return the active cache manager for the current async context.
 *
 * Serves the read-through paths, so a wrong manager is worse than
 * none: a warm hit from another mount's cache is another mount's
 * bytes, where a miss just reads the backend. On an isolating runtime
 * one binding is live and answers as bound; on the fallback storage
 * the manager answers only while every live frame agrees on it, and a
 * disagreement (overlapping commands on different mounts) reads as no
 * manager, failing toward the cold read.
 */
export function activeCacheManager(): CacheInvalidator | null {
  const states = liveCallers().flatMap((caller) => (caller.cache === null ? [] : [caller.cache]))
  const first = states[0]
  if (first === undefined) return null
  for (const state of states) {
    if (state.manager !== first.manager) return null
  }
  return first.manager
}

/**
 * Run `op`, then `settle`, also when `op` fails.
 *
 * An op that fails partway (a paginated delete, a folder copy that merged
 * some children) has already changed the backend, so its record is owed
 * either way. `settle` gets the op's result, or undefined when the op
 * failed. After a failed op a settle error is reported, not thrown, so the
 * caller still learns why the op failed. Mirrors Python's `settle_after`.
 *
 * Args:
 *   op: the backend change.
 *   settle: records what the op changed, given its result.
 */
export async function settleAfter<T>(
  op: () => Promise<T>,
  settle: (result: T | undefined) => Promise<void>,
): Promise<T> {
  let result: T
  try {
    result = await op()
  } catch (error) {
    await settle(undefined).catch((settleError: unknown) => {
      console.warn(`settling after a failed op: ${String(settleError)}`)
    })
    throw error
  }
  await settle(result)
  return result
}

/** A fetch collecting the tokens its bytes carried. */
export interface ReadFacts {
  path: string
  facts: WeakMap<Uint8Array, (string | null)[]>
}

/** Collect tokens belonging to the exact bytes returned by a fetch. */
export async function captureRead<T>(
  path: string,
  fetch: () => Promise<T>,
): Promise<[T, (string | null)[]]> {
  const facts = new WeakMap<Uint8Array, (string | null)[]>()
  return runWithCaller({ ...currentCaller(), readFacts: { path, facts } }, async () => {
    const data = await fetch()
    return [data, data instanceof Uint8Array ? (facts.get(data) ?? []) : []]
  })
}

/** Publish a backend-verified token without activating observation. */
export function publishRead(path: string, data: Uint8Array, fingerprint: string | null): void {
  // Fallback contexts overlap; exact result identity makes broadcast safe.
  for (const capture of liveCallers().flatMap((caller) =>
    caller.readFacts === null ? [] : [caller.readFacts],
  )) {
    if (capture.path !== path) continue
    const tokens = capture.facts.get(data) ?? []
    tokens.push(fingerprint)
    capture.facts.set(data, tokens)
  }
}

/** The write context of the mount at `prefix`. */
export interface WriteBinding {
  prefix: string
  context: WriteContext | null
}

// The cache a backend's writes report to, and what its reads and writes
// note, on the caller: added here, where their shapes live, so the
// caller's module imports no cache module.
declare module '../context/session_context.ts' {
  interface Caller {
    readonly cache: CacheContextState | null
    readonly readFacts: ReadFacts | null
    readonly write: WriteBinding | null
    readonly settledWrite: SettledWrite | null
  }
}

/** Run `fn` with `context` bound as the write context of the mount at `prefix`. */
export function runWithWriteContext<T>(
  prefix: string,
  context: WriteContext | null,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithCaller({ ...currentCaller(), write: { prefix, context }, settledWrite: null }, fn)
}

/**
 * The write context of the current async context. On the fallback storage
 * overlapping lines on different mounts hold frames at once; the mount
 * that owns the path answers, the longest prefix covering it as the mount
 * table routes. Frames there that still disagree, or none covering the
 * path, cannot read as "none", which would send a conditional mount's write
 * unconditioned, so the write is refused instead.
 */
function activeWriteContext(path: PathSpec): WriteContext | null {
  const states = liveCallers().flatMap((caller) => (caller.write === null ? [] : [caller.write]))
  if (agree(states, (state) => state.context)) return states[0]?.context ?? null
  const owners = ownersOf(path, states)
  if (owners.length === 0 || !agree(owners, (state) => state.context)) throw overlapping(path)
  return owners[0]?.context ?? null
}

/** The live frames of the longest prefix covering `path`, as the mount table routes. */
function ownersOf<S extends { prefix: string }>(path: PathSpec, states: readonly S[]): S[] {
  let best = -1
  let owners: S[] = []
  for (const state of states) {
    if (!underPath(path.virtual, state.prefix)) continue
    const length = rstripSlash(state.prefix).length
    if (length > best) [best, owners] = [length, [state]]
    else if (length === best) owners.push(state)
  }
  return owners
}

/** Whether every state picks the same value. */
function agree<S>(states: readonly S[], pick: (state: S) => unknown): boolean {
  return states.every((state, i) => i === 0 || pick(state) === pick(states[0] as S))
}

function overlapping(path: PathSpec): FsError {
  return enotsup('workspace', 'conditional write (overlapping lines)', path)
}

export function runWithSettledWrite<T>(
  owner: Accessor,
  request: ReplaceRequest,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithCaller(
    {
      ...currentCaller(),
      settledWrite: {
        owner,
        scope: currentCaller().write,
        path: request.path.mountPath,
        kind: 'put',
        condition: request.condition,
      },
    },
    fn,
  )
}

export function conditionVersion(condition: WriteCondition | null): string | null {
  return condition?.kind === 'match' ? condition.version : null
}

export function requireSupported(
  support: ConditionSupport,
  vfs: string,
  path: PathSpec,
  kind: WriteKind,
  condition: WriteCondition,
): void {
  if (condition.kind !== 'any' && !(support[kind] ?? []).includes(condition.kind)) {
    throw enotsup(vfs, `conditional ${kind} (${condition.kind})`, path)
  }
}

/**
 * Run a read and return its bytes with the token they carried: the one its
 * backend published for these exact bytes, null when it published none or
 * two that disagree. Mirrors Python's `read_versioned`.
 */
export async function readVersioned<T>(
  path: PathSpec,
  fetch: () => Promise<T>,
): Promise<[T, string | null]> {
  const [data, facts] = await captureRead(path.virtual, fetch)
  const first = facts[0]
  const token = first !== undefined && facts.every((f) => f === first) ? first : null
  return [data, token]
}

/**
 * Resolve explicit read evidence and mount policy into a destination condition.
 * PUT returns Any, Absent, or Match; copy and delete return null outside
 * conditional policy. Mirrors Python's `write_condition`.
 *
 * @throws a stale-write error when the op found removed a file the mount saw
 * @throws an ENOTSUP error when the backend cannot condition this op
 */
export function writeCondition(
  path: PathSpec,
  kind: 'put',
  own?: string | OwnRead | null,
  owner?: Accessor | null,
): Promise<WriteCondition>
export function writeCondition(
  path: PathSpec,
  kind: 'copy' | 'delete',
  own?: string | OwnRead | null,
  owner?: Accessor | null,
): Promise<WriteCondition | null>
export async function writeCondition(
  path: PathSpec,
  kind: WriteKind,
  own: string | OwnRead | null = null,
  owner: Accessor | null = null,
): Promise<WriteCondition | null> {
  const settled = liveCallers()
    .flatMap((caller) => (caller.settledWrite === null ? [] : [caller.settledWrite]))
    .filter(
      (state) => state.owner === owner && state.path === path.mountPath && state.kind === kind,
    )
  const held = settled[0]
  if (held !== undefined) {
    if (
      settled.some(
        (state) =>
          state.scope !== currentCaller().write ||
          state.condition.kind !== held.condition.kind ||
          conditionVersion(state.condition) !== conditionVersion(held.condition),
      )
    )
      throw overlapping(path)
    return held.condition
  }
  const context = activeWriteContext(path)
  if (context === null)
    return kind === 'put' ? (own === OwnRead.ABSENT ? ABSENT_WRITE : ANY_WRITE) : null
  return settle(context, path, kind, own, await context.readVersion(path))
}

/**
 * The condition a delete of `path` carries, null when unconditional: a
 * delete needs no read of its own, only that nobody wrote since, so the
 * version the mount holds, else the one its own lookup found. Mirrors
 * Python's `delete_condition`.
 *
 * @throws an ENOTSUP error when the backend cannot condition a delete
 */
export async function deleteCondition(
  path: PathSpec,
  lookedUp: string | null,
): Promise<WriteCondition | null> {
  const context = activeWriteContext(path)
  if (context === null) return null
  const cached = await context.readVersion(path)
  const version = cached !== null && cached !== '' ? cached : lookedUp
  return condition(context, path, 'delete', version !== '' ? version : null)
}

/**
 * The conditions a move carries: the copy onto `dst` and the source's pin,
 * both versions from one store lookup. Null and null when unconditional.
 * Mirrors Python's `move_condition`.
 *
 * @throws a stale-write error when the op found removed a file the mount saw
 * @throws an ENOTSUP error when the backend cannot condition the move
 */
export async function moveCondition(
  src: PathSpec,
  dst: PathSpec,
): Promise<[WriteCondition | null, string | null]> {
  const context = activeWriteContext(dst)
  if (context === null) return [null, null]
  const [dstCached = null, srcCached = null] = await context.readVersions([dst, src])
  const cond = await settle(context, dst, 'copy', null, dstCached)
  const source = await settle(context, src, 'delete', null, srcCached)
  return [cond, conditionVersion(source)]
}

async function settle(
  context: WriteContext,
  path: PathSpec,
  kind: WriteKind,
  read: string | OwnRead | null,
  cached: string | null,
): Promise<WriteCondition> {
  // The op's own read found no file: one the mount saw was removed since.
  if (read === OwnRead.ABSENT && cached !== null && cached !== '') {
    throw await stale(path, { gone: true })
  }
  if (read === OwnRead.ABSENT && kind === 'put') return ABSENT_WRITE
  const mine = read === OwnRead.ABSENT ? null : read
  const ownToken = mine === '' ? null : mine
  const cachedToken = cached === '' ? null : cached
  return condition(context, path, kind, ownToken ?? cachedToken)
}

function condition(
  context: WriteContext,
  path: PathSpec,
  kind: WriteKind,
  version: string | null,
): WriteCondition {
  // A put with no version goes out plain, so it needs no condition.
  if (kind !== 'put' || version !== null) require(context, path, kind)
  return version !== null ? { kind: 'match', version } : ANY_WRITE
}

function require(context: WriteContext, path: PathSpec, kind: WriteKind): void {
  if (!context.conditions.includes(kind)) throw enotsup(context.vfs, `conditional ${kind}`, path)
}

/**
 * The native token a write sends in place of the held content token, null when
 * the write goes plain. Mirrors Python's `native_condition`.
 */
export async function nativeCondition(
  path: PathSpec,
  cond: WriteCondition | null,
  live: LiveVersion | null,
  kind: WriteKind,
): Promise<string | null> {
  if (cond?.kind === 'absent')
    throw enotsup(activeWriteContext(path)?.vfs ?? 'native', `conditional ${kind} (absent)`, path)
  const held = conditionVersion(cond)
  if (held === null || held === '') return null
  if (live === null) throw await stale(path, { gone: true })
  if (live.content !== held) throw await stale(path, { version: held })
  if (live.native === null || live.native === '') {
    throw enotsup(activeWriteContext(path)?.vfs ?? 'native', `conditional ${kind}`, path)
  }
  return live.native
}

/**
 * Keep the version of every file a walk left behind; refuse the first. Mirrors
 * Python's `keep_refused`.
 */
export async function keepRefused(
  lost: readonly (readonly [PathSpec, string | null])[],
): Promise<StaleWriteError | null> {
  const refusals: StaleWriteError[] = []
  for (const [spec, version] of lost) refusals.push(await stale(spec, { version }))
  return refusals[0] ?? null
}

/**
 * The version the mount holds for each path, in one store round trip. Mirrors
 * Python's `held_versions`.
 */
export async function heldVersions(paths: readonly PathSpec[]): Promise<(string | null)[]> {
  const first = paths[0]
  const context = first === undefined ? null : activeWriteContext(first)
  if (context === null) return paths.map(() => null)
  return context.readVersions(paths)
}

/**
 * Whether the mount that owns `path` is a `write: conditional` one; true while
 * overlapping lines leave the owner unclear. Mirrors Python's
 * `writes_conditioned`.
 */
export function writesConditioned(path: PathSpec): boolean {
  const states = liveCallers().flatMap((caller) => (caller.write === null ? [] : [caller.write]))
  if (agree(states, (state) => state.context)) return (states[0]?.context ?? null) !== null
  const owners = ownersOf(path, states)
  return owners.length === 0 || owners.some((state) => state.context !== null)
}

/**
 * Whether a `kind` on `path` goes out conditioned, for a prefix walk, which
 * conditions each key itself and needs no version for the operand. Mirrors
 * Python's `conditioned`.
 *
 * @throws an ENOTSUP error when the backend cannot condition this op
 */
export function conditioned(path: PathSpec, kind: 'copy' | 'delete'): boolean {
  const context = activeWriteContext(path)
  if (context === null) return false
  require(context, path, kind)
  return true
}

/** Drop the write context's cached copy of `path`, if there is one. */
export async function dropCached(path: PathSpec, keep: string | null = null): Promise<void> {
  markLost(path, keep)
  const context = activeWriteContext(path)
  if (context === null) return
  await context.drop(path)
  if (keep !== null && keep !== '') await context.keep(path, keep)
}

/**
 * The refusal for a lost condition, after dropping the cached copy. The
 * version the write lost on is kept, so a retry without a read is refused
 * again; a file found `gone` keeps none, there being no newer bytes for a
 * retry to overwrite. `landed` marks a move whose copy landed before its
 * source's delete lost, which `mv` reports as a failed removal; `version` is
 * the one the write sent, when the line no longer names it (a move retracts
 * both paths), ABSENT when the op found the file gone, which keeps none.
 * Mirrors Python's `stale`.
 */
export async function stale(
  path: PathSpec,
  options: { landed?: boolean; gone?: boolean; version?: string | OwnRead | null } = {},
): Promise<StaleWriteError> {
  const { landed = false, gone = false, version = null } = options
  const context = activeWriteContext(path)
  const keep =
    !gone && version !== OwnRead.ABSENT && context !== null
      ? (version ?? (await context.readVersion(path)))
      : null
  await dropCached(path, keep)
  return staleWrite(path, landed)
}

/**
 * The versions a prefix walk under `root` measures its keys against: a key
 * the agent read is held to the version it read, and the walk's own listing
 * only stands in for keys it never saw. Mirrors Python's `known_versions`.
 */
export function knownVersions(root: PathSpec, keyPrefix: string): KnownVersions {
  return async (keys) => {
    const known = new Map<string, string>()
    if (keys.length === 0) return known
    const context = activeWriteContext(root)
    if (context === null) return known
    const tokens = await context.readVersions(keys.map((key) => keyPath(root, keyPrefix, key)))
    keys.forEach((key, i) => {
      const token = tokens[i]
      if (token !== null && token !== undefined && token !== '') known.set(key, token)
    })
    return known
  }
}
