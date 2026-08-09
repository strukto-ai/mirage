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

import type { ByteSource } from '../../../io/types.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import type { Resource } from '../../../resource/base.ts'
import { assertMountAllowed, MountNotAllowedError } from '../../../context/session_context.ts'
import type { PathSpec } from '../../../types.ts'
import type { FileStat, ResourceName } from '../../../types.ts'
import type { MountEntry } from '../../mount/mount.ts'
import type { LinkView, MountView, StatOverlay, StatPath } from '../../../ops/types.ts'
import type { Namespace } from '../../mount/namespace/namespace.ts'
import { linkTargetStat, pathExists, pathStat } from '../builtins/links.ts'
import { mergeOverlayStat } from '../../mount/namespace/overlay.ts'
import { MountCommandUnsupported, type MountRegistry } from '../../mount/registry.ts'
import type { Runtime } from '../../../runtime/base.ts'
import { VFSRuntime } from '../../../runtime/table.ts'
import type { PolicyDecision } from '../../../runtime/policy/index.ts'
import type { Session } from '../../session/session.ts'
import { LS_FAILURE } from '../../../commands/builtin/generic/ls.ts'
import type { DispatchFn } from '../cross_mount.ts'
import { applyFindActions } from '../find_action_dispatch.ts'
import { CommandTimeoutError } from '../../../commands/builtin/utils/limit.ts'
import { UsageError } from '../../../commands/errors.ts'
import { formatFsError } from '../../../utils/errors.ts'
import { rstripSlash } from '../../../utils/slash.ts'

import type { Flags } from './types.ts'
import type { FlagValue } from '../../../commands/spec/types.ts'

export interface RunOnMountCtx {
  registry: MountRegistry
  session: Session
  dispatch: DispatchFn
  namespace?: Namespace
  ensureOpen?: (resource: Resource) => Promise<void>
  runtimeBindings?: Record<string, Runtime>
  routingDecision?: PolicyDecision
}

interface RunOnMountOpts {
  stdin?: ByteSource | null
  resolveHint?: PathSpec | null
  mount?: MountEntry | null
}

/** The 126 result for a command no runtime accepted. */
function admissionDenial(cmdName: string): IOResult {
  const msg = `${cmdName}: no runtime accepted this line\n`
  return new IOResult({ exitCode: 126, stderr: new TextEncoder().encode(msg) })
}

/**
 * Resolve a command against the line's routing decision. With no
 * decision, the static bindings apply. With one, the command's runtime
 * is looked up in the decision: its binding, or the decision's
 * fallback when no entry captures it. A resolved VFSRuntime means the
 * executor serves the command itself (the vfs runtime has no
 * interpreter door); null means no runtime accepted it: exit 126,
 * "no runtime accepted this line", like a shell refusing to exec.
 */
function lineRuntimeFor(
  cmdName: string,
  runtimeBindings: Record<string, Runtime> | undefined,
  vfs: Runtime | null,
  routingDecision: PolicyDecision | undefined,
): [Runtime | undefined, IOResult | null] {
  if (routingDecision === undefined) {
    const restricted = vfs instanceof VFSRuntime && vfs.restricted
    const runtime = runtimeBindings?.[cmdName]
    if (runtime !== undefined && runtime === vfs) return [undefined, null]
    if (runtime === undefined && restricted) return [undefined, admissionDenial(cmdName)]
    return [runtime, null]
  }
  const runtime = Object.hasOwn(routingDecision.bindings, cmdName)
    ? routingDecision.bindings[cmdName]
    : routingDecision.fallback
  if (runtime === null || runtime === undefined) return [undefined, admissionDenial(cmdName)]
  if (runtime instanceof VFSRuntime) return [undefined, null]
  return [runtime, null]
}

// `multiple: true` on find value-flags makes parseToKwargs emit arrays;
// bespoke backend wrappers read these as scalars. Migrated backends read the
// expression from `texts` and ignore flagKwargs.
function scalarFindFlags(flagKwargs: Flags): Flags {
  const out: Flags = { ...flagKwargs }
  for (const [key, value] of Object.entries(out)) {
    if (Array.isArray(value)) {
      const last = value.at(-1)
      if (last !== undefined) out[key] = last
    }
  }
  return out
}

// Merge namespace attr overlays into one stat row (ls/stat rendering). A path
// never chown'd defaults its owner to the workspace user (the launch agent,
// what whoami reports) so ls -l and stat -c agree; an unclaimed workspace
// leaves uid/gid null and the formatters fall back to the neutral "user".
function namespaceStatOverlay(namespace: Namespace, virtual: string, stat: FileStat): FileStat {
  const merged = mergeOverlayStat(namespace.metaFor(virtual), stat)
  const user = namespace.user
  if (user === null || (merged.uid !== null && merged.gid !== null)) return merged
  return merged.with({ uid: merged.uid ?? user, gid: merged.gid ?? user })
}

/**
 * The mount prefix serving a virtual path, "/" when none does.
 *
 * A mount boundary is a filesystem boundary, which is what a caller walking up a
 * tree needs in order to stop: `git` looks for a `.git` no further than the
 * mount root, the way real git stops discovery at a filesystem boundary. A path
 * under no mount answers "/" so the walk still terminates.
 */
export function mountRootOf(registry: MountRegistry, virtual: string): string {
  return registry.mountFor(virtual)?.prefix ?? '/'
}

/**
 * The mount-boundary facts on offer to every command.
 *
 * A command that does not read `mounts` off its context simply ignores it, so
 * there is no list of boundary-aware commands to keep in step.
 */
function mountView(registry: MountRegistry): MountView {
  return {
    descendants: (path: string) =>
      registry.descendantMounts(path).map((m) => rstripSlash(m.prefix) || '/'),
    isRoot: (path: string) => registry.isMountRoot(path),
    rootOf: (path: string) => mountRootOf(registry, path),
  }
}

/**
 * Drop cached listings and bodies for the mounts a CLI's service backs.
 *
 * An account CLI mutates its service by id, so no vfs path can be derived from
 * the call and per-path invalidation has nothing to aim at: after
 * `gws sheets spreadsheets create` the new file has no cache entry to expire,
 * which is exactly the case that matters. What is known is the service, so the
 * mounts it backs drop their caches and the next read refetches.
 *
 * Both caches go, because the two hide different writes. A stale listing hides
 * a create or a delete; a stale body hides an edit, and these resources cache
 * reads, so a `cat` after `gws docs documents batchUpdate` would otherwise keep
 * serving the pre-edit content without ever reaching Google.
 *
 * Scoped by the spec's declared `serves` rather than a blanket reset, so a
 * Slack or S3 mount alongside keeps its cache.
 */
export async function dropServiceCaches(
  registry: MountRegistry,
  serves: readonly ResourceName[],
): Promise<void> {
  if (serves.length === 0) return
  const wanted = new Set<string>(serves)
  for (const mount of registry.allMounts()) {
    if (!wanted.has(mount.resource.kind)) continue
    await mount.resource.index?.clear()
    await mount.cacheManager?.dropPrefix()
  }
}

// Run one already-parsed command on the mount that owns its paths. The shared
// single-mount execution tail: mount resolution, session-mode checks, executeCmd,
// filesystem-error formatting, ls/find post-processing, and read/write key
// prefixing. handleCommand uses it for the normal path, and passes it (bound)
// to the cross-mount runners so each operand executes natively on its owning
// mount. `resolveHint` resolves the mount when `paths` is empty (a stream
// command running in stdin mode); a pre-resolved `mount` skips resolution and
// session-mode checks, which the caller already performed.
export async function runOnMount(
  ctx: RunOnMountCtx,
  cmdName: string,
  paths: PathSpec[],
  texts: string[],
  flagKwargs: Flags,
  opts: RunOnMountOpts = {},
): Promise<[ByteSource | null, IOResult]> {
  const { registry, session, dispatch, namespace, ensureOpen, runtimeBindings, routingDecision } =
    ctx
  const hint = opts.resolveHint ?? null
  let mount = opts.mount ?? null
  if (mount === null) {
    const resolvePaths = paths.length > 0 ? paths : hint !== null ? [hint] : []
    try {
      mount = await registry.resolveMount(cmdName, resolvePaths, session.cwd)
    } catch (err) {
      if (err instanceof MountCommandUnsupported) {
        const errBytes = new TextEncoder().encode(`${err.message}\n`)
        return [null, new IOResult({ exitCode: 1, stderr: errBytes })]
      }
      throw err
    }
    if (mount === null) {
      const errBytes = new TextEncoder().encode(`${cmdName}: command not found`)
      return [null, new IOResult({ exitCode: 127, stderr: errBytes })]
    }
    try {
      assertMountAllowed(mount.prefix)
      for (const ps of paths) {
        const target = registry.mountFor(ps.virtual)
        if (target !== null) assertMountAllowed(target.prefix)
      }
    } catch (err) {
      if (err instanceof MountNotAllowedError) {
        const errBytes = new TextEncoder().encode(`${cmdName}: ${err.message}\n`)
        return [null, new IOResult({ exitCode: 1, stderr: errBytes })]
      }
      throw err
    }
  }

  let flags = flagKwargs
  if (cmdName === 'find') flags = scalarFindFlags(flags)

  if (ensureOpen !== undefined) {
    await ensureOpen(mount.resource)
  }

  // resolveMount may redirect a warm remote read to the cache mount, which
  // does not carry the origin mount's per-command limits. Resolve the
  // limit from the real (pre-redirect) mount so the cap survives the hit.
  // A spec can bucket a path-shaped operand as TEXT (python3's script), so
  // when the spec-split paths are empty fall back to the classified scope
  // hint before cwd, mirroring the Python executor.
  const realMount = registry.mountFor(paths[0]?.virtual ?? hint?.virtual ?? session.cwd)
  const limitOverride = realMount?.commandLimits.get(cmdName) ?? null

  // ls/stat render stat rows from the backend's own stat, which never sees
  // namespace attr overlays (chmod/chown/touch on overlay backends) or the
  // default owner; inject the merge so ls -l and stat -c agree.
  // cp/mv -u freshness checks compare the same merged mtimes, and
  // find -mtime filters on them (touch results, observed writes).
  const statOverlay =
    namespace !== undefined
      ? (virtual: string, stat: FileStat) => namespaceStatOverlay(namespace, virtual, stat)
      : null
  // Symlinks are namespace state no backend readdir or stat can see. A
  // command that does not read `links` off its context ignores it, so
  // there is no list of symlink-aware commands to keep in step.
  const links = linkView(namespace ?? null, dispatch, statOverlay)
  // A traversal command's start point is statted through the dispatcher so
  // a start point under another mount answers (`find -L` follows a link
  // across mounts before the command ever runs).
  const statPath: StatPath = (path: string) => pathStat(dispatch, path, statOverlay)

  const [lineRuntime, denial] = lineRuntimeFor(
    cmdName,
    runtimeBindings,
    registry.vfsRuntime,
    routingDecision,
  )
  if (denial !== null) return [null, denial]

  try {
    const [initialStdout, io] = await mount.executeCmd(cmdName, paths, texts, flags, {
      stdin: opts.stdin ?? null,
      cwd: session.cwd,
      dispatch,
      sessionId: session.sessionId,
      env: session.env,
      execAllowed: registry.isExecAllowed(),
      ...(lineRuntime !== undefined ? { runtime: lineRuntime } : {}),
      ...(statOverlay !== null ? { statOverlay } : {}),
      ...(links !== null ? { links } : {}),
      statPath,
      mounts: mountView(registry),
      ...(session.abortSignal !== null ? { signal: session.abortSignal } : {}),
      limitOverride,
    })
    let stdout = initialStdout
    // A minor problem (exit 1: an entry below the operand could not be
    // stat'd) still lists the directory, so the mount and link rows belong in
    // that output; only a failed operand (exit 2) has nothing to augment.
    if (cmdName === 'ls' && io.exitCode !== LS_FAILURE) {
      stdout = await injectChildMounts(stdout, registry, paths, flags, session.cwd)
    }
    if (cmdName === 'find') {
      const [newStdout, actionErr] = await applyFindActions(stdout, flags, registry, session.cwd)
      stdout = newStdout
      if (actionErr.length > 0) {
        const existing = await materialize(io.stderr)
        const merged = new Uint8Array(existing.length + actionErr.length)
        merged.set(existing, 0)
        merged.set(actionErr, existing.length)
        io.stderr = merged
        if (io.exitCode === 0) io.exitCode = 1
      }
    }
    const prefix = rstripSlash(mount.prefix)
    if (prefix !== '') {
      io.reads = prefixKeys(io.reads, prefix)
      io.writes = prefixKeys(io.writes, prefix)
      io.cache = io.cache.map((p) => prefix + p)
    }
    return [stdout, io]
  } catch (err) {
    // Command-owned usage errors (extra operands, missing patterns) become
    // this command's IOResult so the rest of the line keeps running, like a
    // real shell (#452).
    if (err instanceof UsageError) {
      return [
        null,
        new IOResult({
          exitCode: err.exitCode,
          stderr: new TextEncoder().encode(`${err.message}\n`),
        }),
      ]
    }
    // A limit timeout is not a filesystem failure: let it reach the
    // workspace-level handler that answers with exit 124.
    if (err instanceof CommandTimeoutError) throw err
    return [null, new IOResult({ exitCode: 1, stderr: formatFsError(cmdName, err, paths) })]
  }
}

function prefixKeys(obj: Record<string, ByteSource>, prefix: string): Record<string, ByteSource> {
  const out: Record<string, ByteSource> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[prefix + k] = v
  }
  return out
}

// Append symlink entries living under the listed directory. Links are
// namespace state, invisible to backend readdir, so `ls` surfaces them the
// same way child mounts are surfaced. Long form renders GNU-style
// `name -> target`.
// The symlink facts on offer, or null when there are no links.
//
// Which commands actually receive this is decided by whether the
// handler reads `links` off its context, so there is no list of
// symlink-aware commands to keep in step here or anywhere else.
function linkView(
  namespace: Namespace | null,
  dispatch: DispatchFn,
  overlay: StatOverlay | null,
): LinkView | null {
  if (!namespace?.hasLinks()) return null
  return {
    statAt: (path: string) => namespace.linkStatAt(path),
    children: (directory: string) => namespace.linkStatsUnder(directory),
    subtree: (directory: string) => namespace.linkStatsBelow(directory),
    resolve: (path: string) => namespace.follow(path),
    exists: (path: string) => pathExists(dispatch, path),
    targetStat: (path: string) => linkTargetStat(namespace, dispatch, path, overlay),
  }
}

// Names already rendered in an ls listing, for injection dedup.
//
// Long rows come in two shapes: the degraded `mode\t-\t-\tname` form
// used for entries with neither size nor mtime, and the full GNU row
// whose name is the ninth whitespace-separated field. Splitting on tabs
// alone reads a full row as a single field, so a name would never match
// and an injected row could duplicate an entry the backend already
// listed.
function listedNames(existing: string, longForm: boolean): Set<string> {
  const names = new Set<string>()
  for (const line of existing.split('\n')) {
    if (line === '') continue
    if (!longForm) {
      names.add(line.replace(/[/*@|=]$/, ''))
    } else if (line.includes('\t')) {
      names.add(line.split('\t').pop() ?? '')
    } else {
      const parts = line.split(/\s+/)
      if (parts.length >= 9) names.add(parts.slice(8).join(' '))
    }
  }
  names.delete('')
  return names
}

async function injectChildMounts(
  stdout: ByteSource | null,
  registry: MountRegistry,
  paths: readonly PathSpec[],
  flagKwargs: Record<string, FlagValue>,
  cwd: string,
): Promise<ByteSource | null> {
  if (flagKwargs.d === true || flagKwargs.R === true) return stdout
  if (paths.length > 1) return stdout
  const listed = paths.length === 1 && paths[0] !== undefined ? paths[0].virtual : cwd
  const includeHidden = flagKwargs.a === true || flagKwargs.A === true
  const childNames = registry.childMountNames(listed, includeHidden)
  if (childNames.length === 0) return stdout

  const existing = stdout === null ? '' : new TextDecoder().decode(await materialize(stdout))
  const long = flagKwargs.args_l === true
  const classify = flagKwargs.F === true
  const present = listedNames(existing, long)
  const extras: string[] = []
  for (const n of childNames) {
    if (present.has(n)) continue
    if (long) extras.push(`d\t-\t-\t${n}`)
    else extras.push(classify ? `${n}/` : n)
  }
  if (extras.length === 0) return stdout
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
  const combined = existing + sep + extras.join('\n')
  return new TextEncoder().encode(combined)
}
