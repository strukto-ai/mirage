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
import type { PathSpec } from '../../../types.ts'
import type { FileStat, ResourceName } from '../../../types.ts'
import type { MountEntry } from '../../mount/mount.ts'
import type {
  LinkView,
  MountView,
  NamespaceView,
  ReaddirPath,
  StatOverlay,
  StatPath,
} from '../../../ops/types.ts'
import { namespaceNames } from '../../../ops/namespace_view.ts'
import type { Namespace } from '../../mount/namespace/namespace.ts'
import { envSnapshot, sessionView } from '../../session/state.ts'
import { linkTargetStat, pathExists, pathReaddir, pathStat } from '../builtins/links/index.ts'
import { mergeOverlayStat } from '../../mount/namespace/overlay.ts'
import { MountCommandUnsupported, type MountRegistry } from '../../mount/registry.ts'
import type { Runtime } from '../../../runtime/base.ts'
import { VFSRuntime } from '../../../runtime/table.ts'
import type { RouteDecision } from '../../../runtime/routing/index.ts'
import type { Session } from '../../session/session.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { applyFindActions } from '../find_action_dispatch.ts'
import { pathAllowed } from '../../../context/session_context.ts'
import { CommandTimeoutError } from '../../../commands/errors.ts'
import { UsageError } from '../../../commands/errors.ts'
import { readFailExitCode } from '../../../commands/spec/usage.ts'
import { formatFsError } from '../../../utils/errors.ts'
import { rstripSlash } from '../../../utils/slash.ts'

import { mergeSignals } from '../../abort.ts'
import type { Flags } from './types.ts'

export interface RunOnMountCtx {
  registry: MountRegistry
  session: Session
  dispatch: DispatchFn
  namespace?: Namespace
  ensureOpen?: (resource: Resource) => Promise<void>
  runtimeBindings?: Record<string, Runtime>
  routingDecision?: RouteDecision
  signal?: AbortSignal
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
  routingDecision: RouteDecision | undefined,
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

// Merge namespace attr overlays into one stat row (ls/stat rendering). Only
// what chmod/chown/chgrp/touch recorded: a path never chown'd keeps uid and
// gid null, and the owner-rendering commands fall back through `Identity`
// (the workspace user for the owner, the session's profile for the group),
// which is the one rule ls -l, stat -c and find -printf share.
function namespaceStatOverlay(namespace: Namespace, virtual: string, stat: FileStat): FileStat {
  return mergeOverlayStat(namespace.metaFor(virtual), stat)
}

/**
 * The mount prefix serving a virtual path, "/" when none does.
 *
 * A mount boundary is a filesystem boundary, which is what a caller walking up a
 * tree needs in order to stop: `git` looks for a `.git` no further than the
 * mount root, the way real git stops discovery at a filesystem boundary. A path
 * under no mount answers "/" so the walk still terminates.
 */
function mountRootOf(registry: MountRegistry, virtual: string): string {
  return registry.tryMountFor(virtual)?.prefix ?? '/'
}

/**
 * The mount-boundary facts on offer to every command.
 *
 * A command that does not read `mounts` off its context simply ignores it, so
 * there is no list of boundary-aware commands to keep in step.
 */
function mountRootsBelow(registry: MountRegistry, path: string): string[] {
  // Every one, unfiltered: this is the list a caller avoids a boundary
  // with, and a mount the session cannot see still shadows the parent
  // backend's keys under its prefix.
  return registry.descendantMounts(path).map((m) => rstripSlash(m.prefix) || '/')
}

function mountView(registry: MountRegistry): MountView {
  return {
    descendants: (path: string) => mountRootsBelow(registry, path),
    // The list a caller *names* a boundary from. The mount table is not
    // session state, so nothing below filters it: a row in a tree, a
    // member in an archive and a "different filesystem" warning are each
    // produced above every backend, and each one hands back a name the
    // session's hides were meant to withhold.
    visibleDescendants: (path: string) =>
      mountRootsBelow(registry, path).filter((root) => pathAllowed(root)),
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
    // Invalidate rather than clear: a cleared index reads exactly like one
    // that was never filled, so a backend whose index *is* its listing
    // (github seeds the whole tree once) cannot tell the drop from an empty
    // repository. Expiring keeps that distinction and the next read refetches.
    await mount.index?.invalidate()
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
  const realMount = registry.tryMountFor(paths[0]?.virtual ?? hint?.virtual ?? session.cwd)
  const limitOverride = realMount?.commandLimits.get(cmdName) ?? null

  // The name plane's facts, bundled as one view: the attr overlay so
  // ls -l and stat -c agree (cp/mv -u freshness and find -mtime compare
  // the same merged mtimes), the symlink table no backend readdir or
  // stat can see, the mount boundaries, and the child names the
  // namespace owes a directory. A command that does not read `ns` off
  // its context ignores it, so there is no list of aware commands to
  // keep in step.
  const ns = namespaceViewOf(registry, namespace ?? null, dispatch)
  const statOverlay = ns.statOverlay ?? null
  // A traversal command's start point is statted through the dispatcher so
  // a start point under another mount answers (`find -L` follows a link
  // across mounts before the command ever runs).
  const statPath: StatPath = (path: string) => pathStat(dispatch, path, statOverlay)
  // The same door for a listing: a walker whose output is one document
  // (tree) reads the subtree under a nested mount through here, because
  // that subtree lives in a resource its own accessor cannot open.
  const readdirPath: ReaddirPath = (path: string) => pathReaddir(dispatch, path)
  const childMounts = ns.childMounts ?? null

  const [lineRuntime, denial] = lineRuntimeFor(
    cmdName,
    runtimeBindings,
    registry.vfsRuntime,
    routingDecision,
  )
  if (denial !== null) return [null, denial]

  const signal = mergeSignals(ctx.signal, session.abortSignal)
  try {
    const [initialStdout, io] = await mount.executeCmd(cmdName, paths, texts, flags, {
      stdin: opts.stdin ?? null,
      cwd: session.cwd,
      dispatch,
      sessionId: session.sessionId,
      env: envSnapshot(session),
      sessionView: sessionView(session, registry.policies),
      execAllowed: registry.isExecAllowed(),
      execPathAllowed: registry.execAllowedAt,
      ...(lineRuntime !== undefined ? { runtime: lineRuntime } : {}),
      ns,
      statPath,
      readdirPath,
      ...(signal !== undefined ? { signal } : {}),
      limitOverride,
    })
    let stdout = initialStdout
    if (cmdName === 'find') {
      const [newStdout, actionErr] = await applyFindActions(
        stdout,
        flags,
        registry,
        session.cwd,
        childMounts,
        statPath,
      )
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
    if (err instanceof CommandTimeoutError || (err instanceof Error && err.name === 'AbortError'))
      throw err
    return [
      null,
      new IOResult({
        exitCode: readFailExitCode(cmdName, err),
        stderr: formatFsError(cmdName, err, paths),
      }),
    ]
  }
}

function prefixKeys(obj: Record<string, ByteSource>, prefix: string): Record<string, ByteSource> {
  const out: Record<string, ByteSource> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[prefix + k] = v
  }
  return out
}

// The symlink facts on offer, or null when there are no links, built
// with the namespace's own attr overlay so a link's target stat carries
// the same rows `ls -l` renders.
function linkViewFor(namespace: Namespace | null, dispatch: DispatchFn): LinkView | null {
  const overlay =
    namespace !== null
      ? (virtual: string, stat: FileStat) => namespaceStatOverlay(namespace, virtual, stat)
      : null
  return linkView(namespace, dispatch, overlay)
}

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

// The name plane's facts on offer, bundled as one view: symlinks, mount
// boundaries, the attr overlay, the child names the namespace owes a
// directory, and the workspace user. Which commands receive it is decided by whether the handler
// reads `ns` off its context, so there is no list of aware commands to
// keep in step here or anywhere else. Exported for the mount fan-out,
// which reaches `executeCmd` without going through `runOnMount` and
// would otherwise run every sub-command name-plane-blind.
export function namespaceViewOf(
  registry: MountRegistry,
  namespace: Namespace | null,
  dispatch: DispatchFn,
): NamespaceView {
  const links = linkViewFor(namespace, dispatch)
  const statOverlay =
    namespace !== null
      ? (virtual: string, stat: FileStat) => namespaceStatOverlay(namespace, virtual, stat)
      : null
  return {
    ...(links !== null ? { links } : {}),
    mounts: mountView(registry),
    ...(statOverlay !== null ? { statOverlay } : {}),
    childMounts: (parent: string) => namespaceNames(registry.mountPrefixes(), namespace, parent),
    ...(namespace !== null && namespace.user !== null ? { user: namespace.user } : {}),
  }
}
