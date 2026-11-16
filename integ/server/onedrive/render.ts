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

import type { JsonValue } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { baseName, dirName, joinPath, norm } from './paths.ts'
import { childNames, fileAt, dirAt, fileId, folderId, folderSize, versionsOf } from './store.ts'
import type { FileRow } from './store.ts'

// A type rather than an interface: it goes into a JsonValue, whose index
// signature an interface does not satisfy.
type Version = { id: string; lastModifiedDateTime: string }

// A file row without its body: everything an item renders, `size` standing in
// for the content length it is written beside.
interface FileMeta {
  drive: string
  path: string
  size: number
  ctag: string
  etag: string
  modified: string
  seq: number
}

function parentOf(drive: string, path: string): JsonValue {
  return { id: folderId(drive, dirName(norm(path))), driveId: drive }
}

// The download URL is absolute and points back at the host the caller actually
// reached, which is why the origin is a parameter rather than a field the
// server recorded at listen time: behind a port mapping the two differ, and
// the caller can only follow the one it can route to.
function fileJson(tenant: string, origin: string, row: FileMeta, versions: Version[]): JsonValue {
  return {
    id: fileId(row.drive, row.seq),
    name: baseName(row.path),
    parentReference: parentOf(row.drive, row.path),
    createdDateTime: versions.at(-1)?.lastModifiedDateTime ?? row.modified,
    size: row.size,
    lastModifiedDateTime: row.modified,
    cTag: row.ctag,
    eTag: row.etag,
    file: { mimeType: 'application/octet-stream' },
    // Pre-authenticated, like the vendor's own: it is fetched with no bearer,
    // so the account is a path segment rather than something the handler on
    // the other end can read off a header.
    '@microsoft.graph.downloadUrl': `${origin}/download/${encodeURIComponent(tenant)}/${row.drive}/${row.path}`,
    versions,
  }
}

// A folder facet reports an AGGREGATE subtree size, not a content length, and
// mirage's Graph backend is careful to keep that out of FileStat.size for
// exactly that reason. childCount is what `find -empty` reads.
function folderJson(
  drive: string,
  p: string,
  modified: string,
  size: number,
  childCount: number,
): JsonValue {
  return {
    id: folderId(drive, p),
    name: p === '' ? 'root' : baseName(p),
    size,
    lastModifiedDateTime: modified,
    folder: { childCount },
    ...(p === '' ? { root: {} } : { parentReference: parentOf(drive, p) }),
  }
}

export async function fileItem(
  db: C,
  tenant: string,
  origin: string,
  row: FileRow,
): Promise<JsonValue> {
  const versions = await versionsOf(db, tenant, row.drive, row.path)
  return fileJson(tenant, origin, { ...row, size: row.content.length }, versions)
}

export async function folderItem(
  db: C,
  tenant: string,
  drive: string,
  path: string,
  modified: string,
): Promise<JsonValue> {
  const p = norm(path)
  const size = await folderSize(db, tenant, drive, p)
  return folderJson(drive, p, modified, size, (await childNames(db, tenant, drive, p)).length)
}

export async function itemAt(
  db: C,
  tenant: string,
  origin: string,
  drive: string,
  path: string,
  modified: string,
): Promise<JsonValue | null> {
  const p = norm(path)
  const file = await fileAt(db, tenant, drive, p)
  if (file !== null) return fileItem(db, tenant, origin, file)
  if (await dirAt(db, tenant, drive, p)) return folderItem(db, tenant, drive, p, modified)
  return null
}

// One drive read once, for a listing that renders many items. Rendering each
// with fileItem and folderItem cost every child folder two scans of the whole
// drive and an aggregate, and every child file its body: listing a root of a
// few hundred entries took a second and some 1,700 queries.
interface Drive {
  files: Map<string, FileMeta>
  dirs: Set<string>
  names: Map<string, Set<string>>
  sizes: Map<string, number>
}

async function readDrive(db: C, tenant: string, drive: string): Promise<Drive> {
  const rows = await db.graphFile.findMany({
    where: { tenant, drive },
    select: {
      drive: true,
      path: true,
      size: true,
      ctag: true,
      etag: true,
      modified: true,
      seq: true,
    },
  })
  const dirRows = await db.graphDir.findMany({ where: { tenant, drive }, select: { path: true } })
  const names = new Map<string, Set<string>>()
  const sizes = new Map<string, number>()
  const name = (path: string): void => {
    const parent = dirName(path)
    const set = names.get(parent) ?? new Set<string>()
    set.add(baseName(path))
    names.set(parent, set)
  }
  const files = new Map<string, FileMeta>()
  for (const row of rows) {
    files.set(row.path, row)
    name(row.path)
    // folderSize counts a file toward the root, toward a path equal to its own
    // and toward every folder above it.
    sizes.set('', (sizes.get('') ?? 0) + row.size)
    for (let cur = row.path; cur !== ''; cur = dirName(cur)) {
      sizes.set(cur, (sizes.get(cur) ?? 0) + row.size)
    }
  }
  const dirs = new Set<string>()
  for (const row of dirRows) {
    dirs.add(row.path)
    if (row.path !== '') name(row.path)
  }
  return { files, dirs, names, sizes }
}

function namesIn(d: Drive, dir: string): string[] {
  return [...(d.names.get(dir) ?? [])].sort()
}

function folderIn(d: Drive, drive: string, p: string, modified: string): JsonValue {
  return folderJson(drive, p, modified, d.sizes.get(p) ?? 0, namesIn(d, p).length)
}

// versionsOf for many paths in one query, each list newest-first as it is.
async function versionsFor(
  db: C,
  tenant: string,
  drive: string,
  paths: string[],
): Promise<Map<string, Version[]>> {
  const out = new Map<string, Version[]>()
  if (paths.length === 0) return out
  const rows = await db.graphVersion.findMany({
    where: { tenant, drive, path: { in: paths } },
    select: { path: true, versionId: true, modified: true },
    orderBy: { seq: 'asc' },
  })
  for (const v of rows) {
    const list = out.get(v.path) ?? []
    list.push({ id: v.versionId, lastModifiedDateTime: v.modified })
    out.set(v.path, list)
  }
  for (const list of out.values()) list.reverse()
  return out
}

// The children of `dir` as itemAt renders each of them, in name order.
export async function childItems(
  db: C,
  tenant: string,
  origin: string,
  drive: string,
  dir: string,
  modified: string,
): Promise<JsonValue[]> {
  const p = norm(dir)
  const d = await readDrive(db, tenant, drive)
  const paths = namesIn(d, p).map((n) => joinPath(p, n))
  const versions = await versionsFor(
    db,
    tenant,
    drive,
    paths.filter((path) => d.files.has(path)),
  )
  const value: JsonValue[] = []
  for (const path of paths) {
    const file = d.files.get(path)
    if (file !== undefined) value.push(fileJson(tenant, origin, file, versions.get(path) ?? []))
    else if (d.dirs.has(path)) value.push(folderIn(d, drive, path, modified))
  }
  return value
}

// Every item at or under `scope`, folders first and each before its children,
// as a full enumeration lists them; the root folder carries its `root` facet.
export async function scopeItems(
  db: C,
  tenant: string,
  origin: string,
  drive: string,
  scope: string,
  modified: string,
): Promise<JsonValue[]> {
  const inside = (path: string): boolean =>
    scope === '' || path === scope || path.startsWith(`${scope}/`)
  const d = await readDrive(db, tenant, drive)
  const folders = new Set([scope, ...[...d.dirs].filter(inside)])
  const value: JsonValue[] = []
  for (const path of [...folders].sort()) value.push(folderIn(d, drive, path, modified))
  const files = [...d.files.values()]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .filter((row) => inside(row.path))
  const versions = await versionsFor(
    db,
    tenant,
    drive,
    files.map((row) => row.path),
  )
  for (const row of files) value.push(fileJson(tenant, origin, row, versions.get(row.path) ?? []))
  return value
}
