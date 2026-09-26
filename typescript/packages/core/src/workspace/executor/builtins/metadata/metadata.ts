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

import { PolicyDenied } from '../../../../policy/index.ts'
import type { FileStat, SetAttrFields } from '../../../../types.ts'
import { FileType, PathSpec } from '../../../../types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import { fsStrerror } from '../../../../utils/errors.ts'

export function parseOwner(text: string): [number | string | null, number | string | null] {
  const sep = text.indexOf(':')
  const owner = sep >= 0 ? text.slice(0, sep) : text
  const group = sep >= 0 ? text.slice(sep + 1) : ''
  const uid = owner.length > 0 ? (/^\d+$/.test(owner) ? parseInt(owner, 10) : owner) : null
  const gid =
    sep >= 0 && group.length > 0 ? (/^\d+$/.test(group) ? parseInt(group, 10) : group) : null
  return [uid, gid]
}

// Parse a chgrp GROUP argument. Numeric ids become numbers; names are kept
// as strings (mirage has no group database; ownership is stored, not
// enforced). Null when the text is empty.
export function parseGroup(text: string): number | string | null {
  if (text.length === 0) return null
  return /^\d+$/.test(text) ? parseInt(text, 10) : text
}

// Resolve touch -t/-d into an ISO timestamp. `t` is a POSIX
// `[[CC]YY]MMDDhhmm[.ss]` stamp; `d` is a date string (ISO 8601). Returns
// null when neither flag is given; throws Error when the stamp is invalid.
export function parseTouchStamp(t: string | null, d: string | null): string | null {
  if (t !== null) {
    let raw = t
    let seconds = 0
    if (raw.includes('.')) {
      const dot = raw.indexOf('.')
      const secText = raw.slice(dot + 1)
      raw = raw.slice(0, dot)
      if (secText.length !== 2 || !/^\d+$/.test(secText)) throw new Error(t)
      seconds = parseInt(secText, 10)
    }
    if (!/^\d+$/.test(raw)) throw new Error(t)
    if (raw.length === 8) {
      raw = String(new Date().getUTCFullYear()).padStart(4, '0') + raw
    } else if (raw.length === 10) {
      const century = parseInt(raw.slice(0, 2), 10) < 69 ? '20' : '19'
      raw = century + raw
    }
    if (raw.length !== 12) throw new Error(t)
    const dt = new Date(
      Date.UTC(
        parseInt(raw.slice(0, 4), 10),
        parseInt(raw.slice(4, 6), 10) - 1,
        parseInt(raw.slice(6, 8), 10),
        parseInt(raw.slice(8, 10), 10),
        parseInt(raw.slice(10, 12), 10),
        seconds,
      ),
    )
    if (Number.isNaN(dt.getTime())) throw new Error(t)
    if (
      dt.getUTCMonth() !== parseInt(raw.slice(4, 6), 10) - 1 ||
      dt.getUTCDate() !== parseInt(raw.slice(6, 8), 10) ||
      dt.getUTCHours() !== parseInt(raw.slice(8, 10), 10) ||
      dt.getUTCMinutes() !== parseInt(raw.slice(10, 12), 10) ||
      seconds > 59
    ) {
      throw new Error(t)
    }
    return isoNoMs(dt)
  }
  if (d !== null) {
    let normalized = d.replace('Z', '+00:00').replace(' ', 'T')
    if (!normalized.includes('T')) normalized += 'T00:00:00'
    const hasZone = /[+-]\d{2}:\d{2}$/.test(normalized)
    const dt = new Date(hasZone ? normalized : normalized + '+00:00')
    if (Number.isNaN(dt.getTime())) throw new Error(d)
    return isoNoMs(dt)
  }
  return null
}

function isoNoMs(dt: Date): string {
  return dt.toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

export function nowIso(): string {
  return isoNoMs(new Date())
}

export function isReadOnlyError(err: unknown): boolean {
  // A policy deny is EACCES too but must render GNU's "Permission
  // denied", not the mount read-only wording, even when its reason
  // text happens to contain "read-only".
  if (err instanceof PolicyDenied) return false
  return err instanceof Error && err.message.includes('read-only')
}

// A refused attribute write in GNU's per-operand voice, `<cmd>: <action>
// '<path>': Read-only file system`, the voice every other write refusal
// uses. `action` is GNU's phrase for the write (`cannot touch`, `changing
// permissions of`). Mirrors Python's `permission_error`.
export function permissionError(cmd: string, action: string, path: PathSpec, err: unknown): string {
  return `${cmd}: ${action} '${path.rawPath}': ${fsStrerror(err) ?? 'Read-only file system'}\n`
}

// Route one attribute write through the op door. The door applies what
// the backend can hold natively and stores the residual in the namespace
// overlay (dropping overlay fields the backend applied, so a stale
// overlay never shadows the fresh backend value); a VFS with no
// setattr op overlays everything. Kept as a seam so every metadata
// builtin shares one call shape.
export async function setattrVia(
  dispatch: DispatchFn,
  path: PathSpec,
  fields: SetAttrFields,
): Promise<void> {
  await dispatch('setattr', path, [], fields as Record<string, unknown>)
}

// Setattr a link node itself (the -h family): dispatched with `nofollow`
// so the door writes the link entry's own attrs instead of the target's;
// a link has no backend inode, so the door stores them in the overlay.
export async function setattrLink(
  dispatch: DispatchFn,
  path: PathSpec,
  fields: SetAttrFields,
): Promise<void> {
  await dispatch('setattr', path, [], { ...(fields as Record<string, unknown>), nofollow: true })
}

// A subtree as [path, stat] pairs, parents before children. Each entry's
// stat is captured during the walk because chmod's symbolic clauses (u+x)
// build on the entry's own current mode. Symlinks are skipped by name:
// the door's readdir reports them (they are namespace structure), GNU
// chmod -R changes neither a traversed link nor its referent, and the
// skip must come before the stat because stat follows a link and would
// descend through a directory link.
export async function walkStats(
  namespace: Namespace,
  dispatch: DispatchFn,
  root: PathSpec,
  rootStat: FileStat,
): Promise<[PathSpec, FileStat][]> {
  const entries: [PathSpec, FileStat][] = [[root, rootStat]]
  const queue: PathSpec[] = rootStat.type === FileType.DIRECTORY ? [root] : []
  while (queue.length > 0) {
    const directory = queue.shift()
    if (directory === undefined) break
    const [children] = await dispatch('readdir', directory)
    for (const childVirtual of children as string[]) {
      if (namespace.isLink(childVirtual)) continue
      const child = PathSpec.fromStrPath(childVirtual)
      const [childStat] = await dispatch('stat', child)
      const stat = childStat as FileStat
      entries.push([child, stat])
      if (stat.type === FileType.DIRECTORY) queue.push(child)
    }
  }
  return entries
}

// A subtree split into backend paths and namespace link nodes. chown and
// chgrp change a traversed symlink itself rather than its referent (POSIX
// gives -R an implicit -P), and a link is namespace state that no readdir
// can report, so the link nodes are folded back in from the node table.
export async function walkOwned(
  namespace: Namespace,
  dispatch: DispatchFn,
  root: PathSpec,
  rootStat: FileStat,
): Promise<{ paths: PathSpec[]; links: string[] }> {
  const walked = await walkStats(namespace, dispatch, root, rootStat)
  return {
    paths: walked.map(([path]) => path),
    links: namespace.linkStatsBelow(root.virtual).map(([path]) => path),
  }
}
