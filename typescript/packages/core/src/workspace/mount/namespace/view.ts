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

import type { FileStat } from '../../../types.ts'
import type { LinkView, MountView, NamespaceView, StatOverlay } from '../../../ops/types.ts'
import { namespaceNames } from '../../../ops/namespace_view.ts'
import { STAMP_WRITE_OPS } from '../../../ops/config.ts'
import { pathAllowed } from '../../../context/session_context.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { MountRegistry } from '../registry.ts'
import type { Namespace } from './namespace.ts'
import { mergeOverlayStat } from './overlay.ts'
import { linkTargetStat, pathExists, resolveLink } from './probe.ts'

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

// The live symlink facts on offer, or null without a namespace, built
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
  if (namespace === null) return null
  return {
    statAt: (path: string) => namespace.linkStatAt(path),
    children: (directory: string) => namespace.linkStatsUnder(directory),
    subtree: (directory: string) => namespace.linkStatsBelow(directory),
    resolve: (path: string) => resolveLink(namespace, path),
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
    ...(namespace !== null
      ? {
          settleWrite: (op: string, path: string, parents = false) =>
            settleOverlayWrite(namespace, op, path, parents),
          timesUnder: (path: string) => namespace.holdsTimesUnder(path),
        }
      : {}),
    ...(namespace !== null && namespace.user !== null ? { user: namespace.user } : {}),
  }
}

// Settle a command slot's write in the attr overlay, stamped the way the
// dispatcher stamps its own ops: a content write or mkdir records when it
// happened, a removal records nothing.
function settleOverlayWrite(
  namespace: Namespace,
  op: string,
  path: string,
  parents = false,
): Promise<void> {
  const observed = STAMP_WRITE_OPS.has(op) ? Date.now() / 1000 : null
  return namespace.settleWrite(op, path, observed, parents)
}
