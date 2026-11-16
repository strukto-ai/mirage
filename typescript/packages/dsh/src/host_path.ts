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

import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { MountEntry } from '@struktoai/mirage-core/workspace/mount/mount'
import type { NamespaceLinks } from '@struktoai/mirage-core/view/types'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { DiskVFS } from '@struktoai/mirage-node'

/**
 * Whether a `relative()` result leaves the directory it was taken from.
 *
 * Only a bare `..` or a leading `..` SEGMENT escapes: a name may itself
 * begin with two dots (`..draft`), and testing the prefix alone reads
 * that ordinary file as an escape.
 *
 * @param rel the result of `relative(root, target)`.
 * @returns true when the target lies outside the root.
 */
function escapesRoot(rel: string): boolean {
  // An absolute answer means there was no relative route at all, which on
  // win32 is a different drive.
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/**
 * A host path with its symlinks resolved, as a disk mount's root is.
 *
 * A disk mount keeps the real path of its root, so a host path spelled
 * through a link (`/tmp` and `/var` on macOS) would otherwise never fall
 * under it. Every link is followed, the last component's too: a disk
 * mount neither lists nor opens a link below its root, so only the
 * file a link points at has a usable workspace path. The deepest
 * ancestor that resolves is resolved, so a path that names nothing yet,
 * or loops, keeps the rest as written.
 *
 * @param hostPath an absolute host path.
 * @returns the path to compare against a disk mount's root.
 */
function physicalPath(hostPath: string): string {
  const lexical = resolve(hostPath)
  const rest: string[] = []
  let head = lexical
  for (;;) {
    try {
      return join(realpathSync(head), ...rest)
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') throw err
    }
    const parent = dirname(head)
    if (parent === head) return lexical
    rest.unshift(basename(head))
    head = parent
  }
}

/**
 * The prefix of the mount a virtual path actually dispatches to.
 *
 * The deepest mount whose prefix covers the path wins, which is the rule
 * dispatch itself follows; a mount nested inside another's tree owns its
 * subtree outright.
 *
 * @param virtual an absolute virtual path.
 * @param mounts the workspace's mount table.
 * @returns the winning mount's prefix, or undefined when none covers it.
 */
function ownerPrefixOf(virtual: string, mounts: readonly MountEntry[]): string | undefined {
  const probe = virtual.endsWith('/') ? virtual : `${virtual}/`
  let winner: string | undefined
  for (const mount of mounts) {
    if (!probe.startsWith(mount.prefix)) continue
    if (winner === undefined || mount.prefix.length > winner.length) winner = mount.prefix
  }
  return winner
}

/**
 * Whether a namespace symlink stands between a virtual path and the backend.
 *
 * `follow` resolves link components including the final one, so a path it
 * rewrites is one an ordinary read would send somewhere else. A chain it
 * refuses to resolve (a cycle) is not mappable either, and is declined
 * rather than raised: this is a lookup, and the honest answer to "does
 * this host file have a virtual path" is then no.
 *
 * @param links the namespace link table, or null when none is wired.
 * @param virtual the candidate virtual path.
 * @returns true when the path must not be offered.
 */
function shadowedByLink(links: NamespaceLinks | null, virtual: string): boolean {
  if (links === null) return false
  try {
    return links.follow(virtual) !== virtual
  } catch {
    return true
  }
}

/**
 * The workspace path naming the same file as `hostPath`, when a mount
 * puts one there.
 *
 * Most of this world has no host spelling at all: an S3 key, a Slack
 * message and a Notion row are not files the harness could open, and
 * claiming otherwise would hand the caller a path that reads as the
 * wrong bytes. A disk mount is the one place the two worlds hold the
 * same file, so it is the one place a host path is answerable; every
 * other mount declines.
 *
 * @param workspace the workspace whose mounts are consulted.
 * @param hostPath absolute path in the harness host filesystem.
 * @returns the virtual path for the same file, or undefined when no
 *   mount maps it.
 */
export function hostPathToVirtual(workspace: Workspace, hostPath: string): string | undefined {
  if (!isAbsolute(hostPath)) return undefined
  const host = physicalPath(hostPath)
  const mounts = workspace.mounts()
  for (const entry of mounts) {
    const { vfs } = entry
    if (!(vfs instanceof DiskVFS)) continue
    const rel = relative(vfs.root, host)
    if (escapesRoot(rel)) continue
    // `prefix` always carries a trailing slash, and `rel` is empty for
    // the root itself, so the join is a concatenation and the slash is
    // trimmed back off unless the mount is the workspace root.
    const joined = `${entry.prefix}${rel.split(sep).join('/')}`
    const virtual = joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined
    // A mount nested under this one owns its own subtree, and dispatch
    // routes the path there, so the disk file at this host location is
    // not what the virtual path reads. Keep looking rather than name a
    // path that answers with another VFS's bytes.
    if (ownerPrefixOf(virtual, mounts) !== entry.prefix) continue
    // A namespace symlink at or above this path is followed before
    // dispatch, so a read would land on the link's target rather than
    // the disk file the caller named. Links are namespace state, so the
    // disk mount cannot see one and only this table can say.
    if (shadowedByLink(workspace.namespace, virtual)) continue
    return virtual
  }
  return undefined
}
