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

import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import type { PathSpec } from '../../types.ts'
import { eacces, enoent, enotdir } from '../../utils/errors.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { GoogleApiError, type TokenManager } from '../google/client.ts'
import { FOLDER_MIME, MIME_TO_EXT, getFile, listFiles, listSharedDrives } from '../google/drive.ts'
import type { DriveFile } from '../google/drive.ts'

const SUFFIX_TO_MIME: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext, mime])),
)

// A resolved Drive item: enough identity to mutate it.
export interface DriveNode {
  id: string
  name: string
  mimeType: string
  driveId: string | null
}

const ROOT_DRIVE_IDS = new WeakMap<GDriveAccessor, string | null>()

// The mount root's [folder id, shared drive id]. An unscoped mount roots at
// My Drive. A folderId scope may point inside a Shared Drive (or be a Shared
// Drive id itself); its driveId is fetched once via files.get and memoized
// per accessor, so every listing and resolution under the root queries the
// right corpus.
export async function rootContext(accessor: GDriveAccessor): Promise<[string, string | null]> {
  const folderId = accessor.tokenManager.config.folderId
  if (folderId === undefined || folderId === '') return ['root', null]
  if (!ROOT_DRIVE_IDS.has(accessor)) {
    const item = await getFile(accessor.tokenManager, folderId)
    ROOT_DRIVE_IDS.set(accessor, item.driveId ?? null)
  }
  return [folderId, ROOT_DRIVE_IDS.get(accessor) ?? null]
}

// Map a Drive HTTP 403 during a mutation to EACCES. Drive access is per-item
// (shared-drive roles, folder-level grants), so a write-mode mount can still
// hold items the user may not edit; a denied mutation surfaces as Permission
// denied on the operand, like a real filesystem.
export function eaccesOnDenied<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args)
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 403) {
        const spec = args.find(
          (a): a is PathSpec => typeof a === 'object' && a !== null && 'virtual' in a,
        )
        throw eacces(spec ?? '')
      }
      throw err
    }
  }
}

export function isFolder(node: DriveNode): boolean {
  return node.mimeType === FOLDER_MIME
}

export function isNative(node: DriveNode): boolean {
  return node.mimeType in MIME_TO_EXT
}

// Mutations resolve paths with direct Drive queries instead of the read-side
// index: Drive is id-addressed and allows duplicate sibling names, so GNU
// check-then-act semantics (EEXIST, replace-on-rename) need the server's
// current state, not a possibly stale cache.
//
// A google-native file renders as `<name><suffix>` (e.g. `Report.gdoc.json`),
// so a suffixed segment has to be looked up both as a literal Drive name and
// as the stripped native document. They are two *queries*, not two
// priorities: an item from either can render as this segment, and which one
// the path names is decided afterwards by duplicateRank, over the merged set.
// Only a segment ending in a rendered suffix costs the second query, and the
// queries cannot answer with the same item twice -- the literal one matches a
// Drive name equal to the segment, every other one a strictly shorter name.
// Mirrors python's query_candidates.
export function queryCandidates(segment: string): [string, string | null][] {
  const candidates: [string, string | null][] = [[segment, null]]
  for (const [ext, mime] of Object.entries(SUFFIX_TO_MIME)) {
    if (segment.endsWith(ext) && segment.length > ext.length) {
      candidates.push([segment.slice(0, -ext.length), mime])
    }
  }
  return candidates
}

// The vfs name a Drive item is listed and resolved under. A google-apps file
// has no bytes of its own, so the mount renders it as JSON and names it with
// the matching suffix; everything else keeps its Drive name. Written once and
// read by both sides, because the two reach a file by different routes --
// readdir renders every listed item and resolveSegment filters query results
// -- and a name built one way in one of them is a path only one of them can
// reach. Mirrors python's rendered_name.
export function renderedName(name: string, mimeType: string): string {
  return `${name}${MIME_TO_EXT[mimeType] ?? ''}`
}

// Destination Drive name for moving/copying a node to a vfs basename: a
// google-native file's Drive name has no rendered suffix, so the suffix
// matching the node's MIME type is stripped.
export function driveTargetName(basename: string, node: DriveNode): string {
  const ext = MIME_TO_EXT[node.mimeType]
  if (ext !== undefined && basename.endsWith(ext) && basename.length > ext.length) {
    return basename.slice(0, -ext.length)
  }
  return basename
}

/**
 * Selection rank among Drive siblings that share one vfs name.
 *
 * Drive allows duplicate names in a folder, so a vfs path can name more
 * than one item and something has to choose. **Newest `modifiedTime`
 * wins, ties broken by the greater id**, and the rule is written here
 * once because two paths reach the same file: the direct query in
 * `resolveSegment` (which `liveIdentity` and every mutation go through)
 * and the listing that warms the index (which every read goes through).
 * Ordering them differently made `liveIdentity(path)` name a different
 * item than the read of that same path, which a read-check-write caller
 * sees as a conflict with no writer.
 *
 * Both halves are compared as strings: Drive stamps `modifiedTime`
 * RFC3339 with a fixed `Z` offset, so lexical order is chronological
 * order, and the id is a deterministic tiebreak rather than a
 * server-order accident.
 *
 * The rank has no notion of *kind*, deliberately. Two items sharing a
 * vfs name need not be the same kind of thing — a binary file named
 * `Report.gdoc.json` collides with a Google Doc named `Report` (see
 * {@link renderedName}) — and a rule that preferred one kind would have
 * to be spelled identically on both sides to stay agreeable. Recency is
 * the one fact both sides already read off the item. Mirrors python's
 * `duplicate_rank`.
 */
export function duplicateRank(modifiedTime: string, id: string): [string, string] {
  return [modifiedTime, id]
}

// Whether `a` outranks `b` by duplicateRank. Python compares the tuples
// with `>` directly; TypeScript has to spell the comparison out.
export function ranksAbove(a: [string, string], b: [string, string]): boolean {
  return a[0] === b[0] ? a[1] > b[1] : a[0] > b[0]
}

// The one Drive item a name resolves to, by duplicateRank, over every item
// that renders under that one vfs name whichever query found it. Mirrors
// python's pick_duplicate.
export function pickDuplicate(items: readonly DriveFile[]): DriveFile | undefined {
  let best: DriveFile | undefined
  for (const item of items) {
    if (
      best === undefined ||
      ranksAbove(
        duplicateRank(item.modifiedTime ?? '', item.id),
        duplicateRank(best.modifiedTime ?? '', best.id),
      )
    ) {
      best = item
    }
  }
  return best
}

export function nodeFromItem(item: DriveFile, driveId: string | null): DriveNode {
  return {
    id: item.id,
    name: item.name,
    mimeType: item.mimeType ?? '',
    driveId: item.driveId ?? driveId,
  }
}

export async function resolveSegment(
  tm: TokenManager,
  parentId: string,
  segment: string,
  driveId: string | null,
  atRoot: boolean,
): Promise<DriveNode | null> {
  // Every query first, one rank after: a binary file literally named
  // `Report.gdoc.json` and a Google Doc named `Report` render as the same
  // vfs name and are found by different queries, so answering with the
  // first query that matched let the resolver name an item the listing had
  // already ranked below the other one -- the same false conflict
  // duplicateRank exists to close, one level up.
  const matches: DriveFile[] = []
  for (const [name, mime] of queryCandidates(segment)) {
    for (const item of await listFiles(tm, { folderId: parentId, driveId, name, mimeType: mime })) {
      // A query on the literal name also finds items that render under a
      // longer one (a Google Doc actually named `Report.gdoc.json` is
      // `Report.gdoc.json.gdoc.json` in the vfs), and those are a different
      // path's business.
      if (renderedName(item.name, item.mimeType ?? '') === segment) matches.push(item)
    }
  }
  // Not matches[0]: the server's own order is only a proxy for the rule,
  // and the listing that warms the index cannot read it at all. See
  // duplicateRank.
  const best = pickDuplicate(matches)
  if (best !== undefined) return nodeFromItem(best, driveId)
  if (atRoot) {
    // Shared Drive enumeration is best-effort, mirroring readdir: a missing
    // scope must not break resolution of My Drive paths.
    let shared: Awaited<ReturnType<typeof listSharedDrives>>
    try {
      shared = await listSharedDrives(tm)
    } catch {
      shared = []
    }
    for (const d of shared) {
      if (d.name === segment) {
        return { id: d.id, name: segment, mimeType: FOLDER_MIME, driveId: d.id }
      }
    }
  }
  return null
}

// Resolve a mount-relative key ("a/b/c"; "" is the mount root) to its Drive
// item, or null.
export async function resolveKey(accessor: GDriveAccessor, key: string): Promise<DriveNode | null> {
  const tm = accessor.tokenManager
  let [parentId, driveId] = await rootContext(accessor)
  let node: DriveNode | null = null
  const segments = key.split('/').filter((s) => s !== '')
  for (const [i, segment] of segments.entries()) {
    // Shared drive names are only directories at the real Drive root,
    // never inside a folder-scoped mount.
    node = await resolveSegment(tm, parentId, segment, driveId, i === 0 && parentId === 'root')
    if (node === null) return null
    if (i < segments.length - 1) {
      if (!isFolder(node)) throw enotdir('/' + segments.slice(0, i + 1).join('/'))
      parentId = node.id
      driveId = node.driveId
    }
  }
  return node
}

// Resolve a mount-relative key that must be a directory; returns
// [folderId, sharedDriveId | null].
export async function resolveDir(
  accessor: GDriveAccessor,
  key: string,
  virtual: string,
): Promise<[string, string | null]> {
  if (key === '') return rootContext(accessor)
  const node = await resolveKey(accessor, key)
  if (node === null) throw enoent(virtual)
  if (!isFolder(node)) throw enotdir(virtual)
  return [node.id, node.driveId]
}

// Resolve the parent directory of a path for a create-style op.
export async function resolveParent(
  accessor: GDriveAccessor,
  path: PathSpec,
): Promise<[string, string | null]> {
  const key = path.resourcePath
  const parentKey = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''
  const trimmed = rstripSlash(path.virtual)
  const parentVirtual = trimmed.includes('/')
    ? trimmed.slice(0, trimmed.lastIndexOf('/')) || '/'
    : '/'
  return resolveDir(accessor, parentKey, parentVirtual)
}
