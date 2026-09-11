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

import { invalidateAfterWrite } from '../../cache/context.ts'
import { IndexEntry, ResourceType } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { buildTree, emitStartPath, keep, type PredNode } from '../../commands/builtin/find_eval.ts'
import {
  record,
  recordStream,
  recordingActive,
  revisionFor,
  startOp,
} from '../../observe/context.ts'
import type { FindOptions } from '../../resource/base.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { enoent, listingError } from '../../utils/errors.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { windowFor } from '../../utils/ranges.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import type { MsGraphConfigResolved } from './config.ts'
import {
  GraphError,
  graphDelete,
  graphGet,
  graphGetBytes,
  graphList,
  graphPatch,
  graphPost,
  graphPostMonitor,
  graphPutBytes,
  graphStream,
  pollMonitor,
  uploadChunk,
} from './client.ts'
import { compareCodePoints } from '../../utils/sort.ts'

const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024
const UPLOAD_CHUNK = 10 * 327680

export type DriveUrl = (path: string, action?: string) => string
export type DriveRef = (folder?: string) => string

export class DriveLoc {
  readonly drive: string
  readonly path: string
  readonly virtual: string
  private readonly url: DriveUrl
  private readonly ref: DriveRef

  constructor(init: {
    drive: string
    path: string
    virtual: string
    url: DriveUrl
    ref: DriveRef
  }) {
    this.drive = init.drive
    this.path = init.path
    this.virtual = init.virtual
    this.url = init.url
    this.ref = init.ref
  }

  item(action = ''): string {
    return this.url(this.path, action)
  }

  // Any item on the same drive, addressed the way this loc addresses its
  // own. The ancestor probes need it: a DriveLoc's `path` is already
  // spelled the way its url callable expects, so an ancestor of it is too.
  itemAt(path: string, action = ''): string {
    return this.url(path, action)
  }

  child(name: string): DriveLoc {
    return new DriveLoc({
      drive: this.drive,
      path: this.path !== '' ? `${this.path}/${name}` : name,
      virtual: this.virtual !== '' ? `${this.virtual}/${name}` : name,
      url: this.url,
      ref: this.ref,
    })
  }

  parent(): string {
    const index = this.path.lastIndexOf('/')
    return index < 0 ? '' : this.path.slice(0, index)
  }

  reference(folder = ''): string {
    return this.ref(folder)
  }
}

function baseName(path: string): string {
  const stripped = rstripSlash(path)
  const index = stripped.lastIndexOf('/')
  return index < 0 ? stripped : stripped.slice(index + 1)
}

function virtSpec(loc: DriveLoc): PathSpec {
  const stripped = stripSlash(loc.virtual)
  return PathSpec.fromStrPath(stripped !== '' ? `/${stripped}` : '/', stripped)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isFolder(item: Record<string, unknown>): boolean {
  return item.folder !== undefined
}

// Graph returns the folder facet's childCount by default, so `-empty` needs
// no extra request. Absent (a $select that dropped it) reads as unknown.
export function folderChildCount(item: Record<string, unknown>): number | null {
  const facet = item.folder
  if (facet === null || typeof facet !== 'object' || Array.isArray(facet)) return null
  return asNumber((facet as Record<string, unknown>).childCount)
}

function parentReference(src: DriveLoc, dst: DriveLoc): Record<string, unknown> {
  const reference: Record<string, unknown> = { path: dst.reference(dst.parent()) }
  if (src.drive !== dst.drive && dst.drive !== '') reference.driveId = dst.drive
  return reference
}

async function copyOnce(
  config: MsGraphConfigResolved,
  src: DriveLoc,
  dst: DriveLoc,
): Promise<GraphError | null> {
  try {
    const monitor = await graphPostMonitor(config, src.item('/copy'), {
      name: baseName(dst.path),
      parentReference: parentReference(src, dst),
    })
    const result = await pollMonitor(monitor, config.timeout)
    if (result.status === 'completed') return null
    const error =
      result.error !== null && typeof result.error === 'object' && !Array.isArray(result.error)
        ? (result.error as Record<string, unknown>)
        : {}
    if (result.status === 'failed') {
      return new GraphError(
        500,
        asString(error.code) ?? 'copyFailed',
        asString(error.message) ?? `copy ${src.path} -> ${dst.path} failed`,
      )
    }
    throw new GraphError(504, 'copyTimeout', `copy ${src.path} -> ${dst.path} not confirmed`)
  } catch (error) {
    if (
      error instanceof GraphError &&
      (error.status === 409 || error.code === 'nameAlreadyExists')
    ) {
      return error
    }
    throw error
  }
}

export async function copyTree(
  config: MsGraphConfigResolved,
  src: DriveLoc,
  dst: DriveLoc,
): Promise<void> {
  const conflict = await copyOnce(config, src, dst)
  if (conflict === null) {
    await invalidateAfterWrite(virtSpec(dst))
    return
  }
  if (conflict.code !== 'nameAlreadyExists') throw conflict
  const srcItem = await graphGet(config, src.item())
  const dstItem = await graphGet(config, dst.item())
  if (isFolder(srcItem) && isFolder(dstItem)) {
    for (const child of await graphList(config, src.item('/children'))) {
      const name = asString(child.name) ?? ''
      await copyTree(config, src.child(name), dst.child(name))
    }
    return
  }
  if (isFolder(srcItem) || isFolder(dstItem)) throw conflict
  await graphDelete(config, dst.item())
  const secondConflict = await copyOnce(config, src, dst)
  if (secondConflict !== null) throw secondConflict
  await invalidateAfterWrite(virtSpec(dst))
}

export async function renameReplace(
  config: MsGraphConfigResolved,
  src: DriveLoc,
  dst: DriveLoc,
): Promise<void> {
  const body: Record<string, unknown> = { name: baseName(dst.path) }
  if (src.parent() !== dst.parent() || src.drive !== dst.drive) {
    body.parentReference = { path: dst.reference(dst.parent()) }
  }
  try {
    await graphPatch(config, src.item(), body)
  } catch (error) {
    if (
      !(error instanceof GraphError) ||
      (error.status !== 409 && error.code !== 'nameAlreadyExists')
    ) {
      throw error
    }
    const destination = await graphGet(config, dst.item())
    if (isFolder(destination)) {
      const children = await graphList(config, dst.item('/children'))
      if (children.length > 0) throw error
    }
    await graphDelete(config, dst.item())
    await graphPatch(config, src.item(), body)
  }
}

export async function createChildFolder(
  config: MsGraphConfigResolved,
  parentUrl: string,
  name: string,
): Promise<void> {
  try {
    await graphPost(config, parentUrl, {
      name,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    })
  } catch (error) {
    if (
      !(error instanceof GraphError) ||
      (error.status !== 409 && error.code !== 'nameAlreadyExists')
    ) {
      throw error
    }
  }
}

async function uploadSessionWrite(
  config: MsGraphConfigResolved,
  sessionUrl: string,
  data: Uint8Array,
): Promise<void> {
  const session = await graphPost(config, sessionUrl, {
    item: { '@microsoft.graph.conflictBehavior': 'replace' },
  })
  const uploadUrl = asString(session.uploadUrl)
  if (uploadUrl === null) throw new GraphError(502, 'missingUploadUrl', sessionUrl)
  let start = 0
  while (start < data.length) {
    const chunk = data.slice(start, start + UPLOAD_CHUNK)
    const result = await uploadChunk(config, uploadUrl, chunk, start, data.length)
    const ranges = result.nextExpectedRanges
    if (Array.isArray(ranges) && typeof ranges[0] === 'string') {
      start = Number.parseInt(ranges[0].split('-', 1)[0] ?? '', 10)
    } else {
      start += chunk.length
    }
  }
}

export async function writeItem(
  config: MsGraphConfigResolved,
  loc: DriveLoc,
  data: Uint8Array,
): Promise<void> {
  if (data.length <= SIMPLE_UPLOAD_MAX) {
    await graphPutBytes(config, loc.item('/content'), data)
  } else {
    await uploadSessionWrite(config, loc.item('/createUploadSession'), data)
  }
}

function entryStat(item: Record<string, unknown>): FileStat {
  const name = asString(item.name) ?? ''
  if (isFolder(item)) {
    // Graph's folder `size` is aggregate storage metadata, not the byte
    // length of any rendered content: keep it out of FileStat.size (see
    // CLAUDE.md FUSE rules) and expose it as `extra.size_bytes`.
    return new FileStat({
      name,
      type: FileType.DIRECTORY,
      modified: asString(item.lastModifiedDateTime),
      extra: { size_bytes: asNumber(item.size), child_count: folderChildCount(item) },
    })
  }
  return new FileStat({
    name,
    type: FileType.FILE,
    content: contentTypeForPath(name),
    size: asNumber(item.size),
    modified: asString(item.lastModifiedDateTime),
    fingerprint: asString(item.cTag),
    extra: { id: item.id, ctag: item.cTag, etag: item.eTag },
  })
}

function currentVersionId(versions: Record<string, unknown>[]): string | null {
  let current: Record<string, unknown> | null = null
  for (const version of versions) {
    if (
      current === null ||
      (asString(version.lastModifiedDateTime) ?? '') >
        (asString(current.lastModifiedDateTime) ?? '')
    ) {
      current = version
    }
  }
  return current === null ? null : asString(current.id)
}

async function captureItemMetadata(
  config: MsGraphConfigResolved,
  loc: DriveLoc,
): Promise<[string | null, string | null, string | null]> {
  const item = await graphGet(config, loc.item(), { $expand: 'versions' })
  const versions = Array.isArray(item.versions)
    ? item.versions.filter(
        (value): value is Record<string, unknown> =>
          value !== null && typeof value === 'object' && !Array.isArray(value),
      )
    : []
  return [
    asString(item.cTag),
    currentVersionId(versions),
    asString(item['@microsoft.graph.downloadUrl']),
  ]
}

export async function readItem(
  config: MsGraphConfigResolved,
  loc: DriveLoc,
  virtual: string,
  label: string,
  backend: string,
  offset = 0,
  size: number | null = null,
): Promise<Uint8Array> {
  const pinned = revisionFor(virtual)
  const window = windowFor(offset, size)
  const timer = startOp()
  let fingerprint: string | null = null
  let revision: string | null = pinned
  try {
    let data: Uint8Array
    if (pinned !== null) {
      data = await graphGetBytes(
        config,
        loc.item(`/versions/${encodeURIComponent(pinned)}/content`),
        window,
      )
    } else if (recordingActive()) {
      let downloadUrl: string | null
      ;[fingerprint, revision, downloadUrl] = await captureItemMetadata(config, loc)
      data =
        downloadUrl === null
          ? await graphGetBytes(config, loc.item('/content'), window)
          : await graphGetBytes(config, downloadUrl, window, false)
    } else {
      data = await graphGetBytes(config, loc.item('/content'), window)
    }
    record('read', label, backend, data.length, timer, { fingerprint, revision })
    return data
  } catch (error) {
    if (error instanceof GraphError && error.status === 404) throw enoent(virtual)
    throw error
  }
}

export async function* streamItem(
  config: MsGraphConfigResolved,
  loc: DriveLoc,
  virtual: string,
  label: string,
  backend: string,
): AsyncIterable<Uint8Array> {
  const pinned = revisionFor(virtual)
  const rec = recordStream('read', label, backend)
  let url = loc.item('/content')
  let auth = true
  try {
    if (pinned !== null) {
      url = loc.item(`/versions/${encodeURIComponent(pinned)}/content`)
      if (rec !== null) rec.revision = pinned
    } else if (rec !== null) {
      let downloadUrl: string | null
      ;[rec.fingerprint, rec.revision, downloadUrl] = await captureItemMetadata(config, loc)
      if (downloadUrl !== null) {
        url = downloadUrl
        auth = false
      }
    }
    for await (const chunk of graphStream(config, url, auth)) {
      if (rec !== null) rec.bytes += chunk.length
      yield chunk
    }
  } catch (error) {
    if (error instanceof GraphError && error.status === 404) throw enoent(virtual)
    throw error
  }
}

async function* iterTree(
  config: MsGraphConfigResolved,
  loc: DriveLoc,
): AsyncIterable<[string, Record<string, unknown>, boolean]> {
  for (const child of await graphList(config, loc.item('/children'))) {
    const childLoc = loc.child(asString(child.name) ?? '')
    const folder = isFolder(child)
    yield [childLoc.virtual, child, folder]
    if (folder) yield* iterTree(config, childLoc)
  }
}

export async function duTreeTotal(config: MsGraphConfigResolved, loc: DriveLoc): Promise<number> {
  let total = 0
  for await (const [, item, folder] of iterTree(config, loc)) {
    if (!folder) total += asNumber(item.size) ?? 0
  }
  return total
}

export async function duTreeEntries(
  config: MsGraphConfigResolved,
  loc: DriveLoc,
): Promise<[[string, number][], number]> {
  const entries: [string, number][] = []
  let total = 0
  for await (const [relative, item, folder] of iterTree(config, loc)) {
    if (folder) continue
    const size = asNumber(item.size) ?? 0
    entries.push([`/${relative}`, size])
    total += size
  }
  return [entries, total]
}

// Walk knobs for callers that stack findItems under synthetic namespace
// levels (SharePoint's site/library directories): `depthOffset` shifts the
// reported depth so `-maxdepth`/`-mindepth` count from the real start path,
// and `emitStart` suppresses the per-library start path so only the caller's
// own start is emitted.
export interface DriveWalk {
  depthOffset?: number
  emitStart?: boolean
}

export async function findItems(
  config: MsGraphConfigResolved,
  loc: DriveLoc,
  startName: string,
  dirExists: () => Promise<boolean>,
  options: FindOptions = {},
  walk: DriveWalk = {},
): Promise<string[]> {
  const results: string[] = []
  let sawDescendant = false
  const tree: PredNode =
    options.tree ??
    buildTree({
      name: options.name,
      iname: options.iname,
      pathPattern: options.pathPattern,
      type: options.type,
      nameExclude: options.nameExclude,
      orNames: options.orNames,
      empty: options.empty,
    })
  const offset = walk.depthOffset ?? 0
  let startChildren = 0
  for await (const [relative, item, folder] of iterTree(config, loc)) {
    const childPath = loc.virtual === '' ? relative : relative.slice(loc.virtual.length + 1)
    const relDepth = childPath.split('/').length
    const depth = relDepth + offset
    if (relDepth === 1) startChildren += 1
    if (options.maxDepth != null && depth > options.maxDepth) continue
    sawDescendant = true
    const size = asNumber(item.size) ?? 0
    const entry = {
      key: `/${relative}`,
      name: baseName(relative),
      kind: folder ? ('d' as const) : ('f' as const),
      depth,
      isEmpty: options.empty === true ? (folder ? folderChildCount(item) === 0 : size === 0) : null,
    }
    if (!keep(entry, tree, options.minDepth)) continue
    const effective = folder ? 0 : size
    if (options.minSize != null && effective < options.minSize) continue
    if (options.maxSize != null && effective > options.maxSize) continue
    results.push(entry.key)
  }
  if (walk.emitStart !== false && (sawDescendant || (await dirExists()))) {
    emitStartPath(results, loc.virtual === '' ? '/' : `/${loc.virtual}`, startName, {
      kind: 'd',
      isEmpty: options.empty === true ? startChildren === 0 : null,
      exists: true,
      tree,
      maxDepth: options.maxDepth,
      minDepth: options.minDepth,
      minSize: options.minSize,
      maxSize: options.maxSize,
    })
  }
  return results.sort(compareCodePoints)
}

// One bounded page, not graphList: the answer is a yes/no, and graphList
// follows every @odata.nextLink, so asking it made a large folder download
// its whole listing to produce one boolean. $top through that helper is
// worse rather than better -- it only shrinks each page, so the walk pages
// more times, not fewer -- which is why this sends the request itself.
// $select drops a driveItem payload this never reads.
export async function driveRootEmpty(
  config: MsGraphConfigResolved,
  loc: DriveLoc,
): Promise<boolean> {
  const page = await graphGet(config, loc.item('/children'), { $top: 1, $select: 'id' })
  return !(Array.isArray(page.value) && page.value.length > 0)
}

async function itemOrNull(
  config: MsGraphConfigResolved,
  loc: DriveLoc,
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await graphGet(config, loc.itemAt(stripSlash(path)))
  } catch (error) {
    if (error instanceof GraphError && error.status === 404) return null
    throw error
  }
}

async function isFile(
  config: MsGraphConfigResolved,
  loc: DriveLoc,
  path: string,
): Promise<boolean> {
  const item = await itemOrNull(config, loc, path)
  return item !== null && !('folder' in item)
}

async function isDir(config: MsGraphConfigResolved, loc: DriveLoc, path: string): Promise<boolean> {
  const item = await itemOrNull(config, loc, path)
  return item !== null && 'folder' in item
}

export async function readdirItems(
  config: MsGraphConfigResolved,
  loc: DriveLoc,
  index: IndexCacheStore | undefined,
  prefix: string,
  stripped: string,
  virtualKey: string,
  path: PathSpec,
): Promise<string[]> {
  let children: Record<string, unknown>[]
  try {
    children = await graphList(config, loc.item('/children'))
  } catch (error) {
    if (!(error instanceof GraphError) || error.status !== 404) throw error
    // Graph 404s a children listing for a missing item and for one under a
    // file alike, so the errno comes from walking the ancestors: one item
    // request per component, on this failure path only.
    throw await listingError(
      path,
      loc.path,
      (p) => isFile(config, loc, p),
      (p) => isDir(config, loc, p),
    )
  }
  const base = stripped !== '' ? `/${stripped}` : ''
  const names: string[] = []
  const entries: [string, IndexEntry][] = []
  for (const child of children) {
    const name = asString(child.name) ?? ''
    const path = `${base}/${name}`
    const folder = isFolder(child)
    names.push(path)
    entries.push([
      name,
      new IndexEntry({
        id: path,
        name,
        resourceType: folder ? ResourceType.FOLDER : ResourceType.FILE,
        // Folder `size` is aggregate storage metadata, never rendered
        // content length: cache it as extra, not as the entry size.
        size: folder ? null : asNumber(child.size),
        remoteTime: asString(child.lastModifiedDateTime) ?? '',
        extra: folder
          ? {
              ctag: child.cTag,
              etag: child.eTag,
              size_bytes: asNumber(child.size),
              child_count: folderChildCount(child),
            }
          : { ctag: child.cTag, etag: child.eTag },
      }),
    ])
  }
  names.sort(compareCodePoints)
  if (index !== undefined) await index.setDir(virtualKey, entries)
  return names.map((name) => (prefix !== '' ? prefix + name : name))
}

export async function statItem(
  config: MsGraphConfigResolved,
  loc: DriveLoc,
  path: PathSpec,
  virtualKey: string,
  index?: IndexCacheStore,
): Promise<FileStat> {
  if (index !== undefined) {
    const lookup = await index.get(virtualKey)
    if (lookup.entry !== undefined && lookup.entry !== null) {
      const entry = lookup.entry
      return new FileStat({
        name: entry.name,
        type: entry.resourceType === ResourceType.FOLDER ? FileType.DIRECTORY : FileType.FILE,
        content: entry.resourceType === ResourceType.FOLDER ? null : contentTypeForPath(entry.name),
        size: entry.size,
        modified: entry.remoteTime || null,
        fingerprint: asString(entry.extra.ctag),
        extra: entry.extra,
      })
    }
    const parent = virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
    const listing = await index.listDir(parent)
    if (listing.entries !== undefined && listing.entries !== null) throw enoent(path)
  }
  try {
    return entryStat(await graphGet(config, loc.item()))
  } catch (error) {
    if (error instanceof GraphError && error.status === 404) throw enoent(path)
    throw error
  }
}

// Graph has no cheap HEAD for an item, so existence is a stat that tolerates
// ENOENT. Both drive backends address items differently but probe
// identically, so only their stat is injected.
export function makeExists<A>(
  stat: (accessor: A, path: PathSpec) => Promise<unknown>,
): (accessor: A, path: PathSpec) => Promise<boolean> {
  return async (accessor, path) => {
    try {
      await stat(accessor, path)
      return true
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return false
      throw error
    }
  }
}

// Graph exposes no truncate, so the whole item is rewritten. A missing item
// truncates to a fresh one, matching `open(path, "w")`.
export function makeTruncate<A>(
  read: (accessor: A, path: PathSpec) => Promise<Uint8Array>,
  write: (accessor: A, path: PathSpec, data: Uint8Array) => Promise<void>,
): (accessor: A, path: PathSpec, length: number) => Promise<void> {
  return async (accessor, path, length) => {
    let data: Uint8Array
    try {
      data = await read(accessor, path)
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
      data = new Uint8Array()
    }
    const resized = new Uint8Array(length)
    resized.set(data.slice(0, length))
    await write(accessor, path, resized)
  }
}
