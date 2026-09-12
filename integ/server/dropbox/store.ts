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

import type { Minter } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { dirname, type Item } from './wire.ts'

// Every row carries the tenant, and the tenant is the account, so the WHERE
// clause is written once here rather than at each of the twenty call sites.
function where(tenant: string): { tenant: string } {
  return { tenant }
}

function key(tenant: string, path: string): { tenant_path: { tenant: string; path: string } } {
  return { tenant_path: { tenant, path } }
}

function toItem(row: {
  path: string
  isFolder: boolean
  content: Uint8Array | null
  modified: string | null
}): Item {
  return { path: row.path, isFolder: row.isFolder, content: row.content, modified: row.modified }
}

export async function itemAt(db: C, tenant: string, path: string): Promise<Item | null> {
  if (path === '') return null
  const row = await db.dropboxItem.findUnique({ where: key(tenant, path) })
  return row === null ? null : toItem(row)
}

export async function fileAt(db: C, tenant: string, path: string): Promise<Item | null> {
  const item = await itemAt(db, tenant, path)
  return item === null || item.isFolder ? null : item
}

// Real Dropbox has no separate mkdir -p: uploading to /a/b/c.txt materialises
// /a and /a/b as folder objects, and a later list_folder on /a has to see /a/b.
// The rows are created rather than upserted per level so an existing folder
// keeps its seq, which is what makes a re-upload leave a listing unchanged.
export async function addAncestors(
  db: C,
  tenant: string,
  path: string,
  minter: Minter,
): Promise<void> {
  const parts = path.split('/').slice(1, -1)
  let cur = ''
  for (const part of parts) {
    cur += `/${part}`
    const found = await db.dropboxItem.findUnique({ where: key(tenant, cur) })
    if (found !== null) continue
    await db.dropboxItem.create({
      data: {
        tenant,
        path: cur,
        isFolder: true,
        content: null,
        modified: null,
        seq: minter.next('item'),
      },
    })
  }
}

export async function addFolder(
  db: C,
  tenant: string,
  path: string,
  minter: Minter,
): Promise<Item> {
  await addAncestors(db, tenant, path, minter)
  const row = await db.dropboxItem.create({
    data: { tenant, path, isFolder: true, content: null, modified: null, seq: minter.next('item') },
  })
  await db.dropboxTombstone.deleteMany({ where: { tenant, path } })
  return toItem(row)
}

export async function putFile(
  db: C,
  tenant: string,
  path: string,
  content: Uint8Array<ArrayBuffer>,
  modified: string,
  minter: Minter,
): Promise<Item> {
  await addAncestors(db, tenant, path, minter)
  const row = await db.dropboxItem.upsert({
    where: key(tenant, path),
    update: { isFolder: false, content, modified, seq: minter.next('item') },
    create: { tenant, path, isFolder: false, content, modified, seq: minter.next('item') },
  })
  await db.dropboxTombstone.deleteMany({ where: { tenant, path } })
  return toItem(row)
}

// null means the path names no folder, which the caller reports as
// path/not_found; an empty array means a real but empty folder.
export async function listChildren(
  db: C,
  tenant: string,
  path: string,
  recursive: boolean,
): Promise<Item[] | null> {
  if (path !== '') {
    const at = await db.dropboxItem.findUnique({ where: key(tenant, path) })
    if (at === null || !at.isFolder) return null
  }
  const rows = await db.dropboxItem.findMany({ where: where(tenant), orderBy: { seq: 'asc' } })
  const prefix = `${path}/`
  const out = rows
    .filter((r) => (recursive ? r.path.startsWith(prefix) : dirname(r.path) === path))
    .map(toItem)
  // A recursive listing is ordered parent-before-child, which is what the
  // vendor guarantees and what a consumer building a tree from the stream
  // relies on; a shallow one is ordered by name, which is what it renders.
  return recursive
    ? out.sort((a, b) => (a.path < b.path ? -1 : 1))
    : out.sort((a, b) =>
        a.path.slice(a.path.lastIndexOf('/')) < b.path.slice(b.path.lastIndexOf('/')) ? -1 : 1,
      )
}

// Removes a file, or a folder plus its subtree (delete_v2 semantics).
export async function remove(
  db: C,
  tenant: string,
  path: string,
  minter: Minter,
): Promise<boolean> {
  const at = await db.dropboxItem.findUnique({ where: key(tenant, path) })
  if (at === null) return false
  const doomed = at.isFolder
    ? [
        path,
        ...(
          await db.dropboxItem.findMany({
            where: { tenant, path: { startsWith: `${path}/` } },
            select: { path: true },
          })
        ).map((row) => row.path),
      ]
    : [path]
  await db.dropboxItem.delete({ where: key(tenant, path) })
  if (at.isFolder) {
    await db.dropboxItem.deleteMany({ where: { tenant, path: { startsWith: `${path}/` } } })
  }
  for (const gone of doomed) {
    await db.dropboxTombstone.upsert({
      where: { tenant_path: { tenant, path: gone } },
      update: { seq: minter.next('item') },
      create: { tenant, path: gone, seq: minter.next('item') },
    })
  }
  return true
}

function inScope(itemPath: string, root: string, recursive: boolean): boolean {
  if (root === '') return true
  if (recursive) return itemPath === root || itemPath.startsWith(`${root}/`)
  return dirname(itemPath) === root
}

export async function maxItemSeq(db: C, tenant: string): Promise<number> {
  const item = await db.dropboxItem.aggregate({ where: where(tenant), _max: { seq: true } })
  const tomb = await db.dropboxTombstone.aggregate({
    where: where(tenant),
    _max: { seq: true },
  })
  return Math.max(item._max.seq ?? 0, tomb._max.seq ?? 0)
}

export async function changesSince(
  db: C,
  tenant: string,
  path: string,
  recursive: boolean,
  seq: number,
): Promise<{ items: Item[]; deleted: string[] }> {
  const rows = await db.dropboxItem.findMany({
    where: { tenant, seq: { gt: seq } },
    orderBy: { seq: 'asc' },
  })
  const tombs = await db.dropboxTombstone.findMany({
    where: { tenant, seq: { gt: seq } },
    orderBy: { seq: 'asc' },
  })
  return {
    items: rows.filter((row) => inScope(row.path, path, recursive)).map(toItem),
    deleted: tombs.filter((row) => inScope(row.path, path, recursive)).map((row) => row.path),
  }
}

// Copies a file or a folder subtree. The caller has already refused a
// conflicting destination, so this only has to place rows.
export async function copyTree(
  db: C,
  tenant: string,
  from: string,
  to: string,
  minter: Minter,
): Promise<boolean> {
  const src = await db.dropboxItem.findUnique({ where: key(tenant, from) })
  if (src === null) return false
  await addAncestors(db, tenant, to, minter)
  await db.dropboxItem.create({
    data: {
      tenant,
      path: to,
      isFolder: src.isFolder,
      content: src.content,
      modified: src.modified,
      seq: minter.next('item'),
    },
  })
  if (!src.isFolder) return true
  const under = await db.dropboxItem.findMany({
    where: { tenant, path: { startsWith: `${from}/` } },
    orderBy: { seq: 'asc' },
  })
  for (const row of under) {
    await db.dropboxItem.create({
      data: {
        tenant,
        path: `${to}${row.path.slice(from.length)}`,
        isFolder: row.isFolder,
        content: row.content,
        modified: row.modified,
        seq: minter.next('item'),
      },
    })
  }
  return true
}

// Scope is a path the search is confined to; '' is the whole account. null
// means the scope names nothing, which the caller reports as path/not_found.
export async function scopedItems(db: C, tenant: string, scope: string): Promise<Item[] | null> {
  const rows = await db.dropboxItem.findMany({ where: where(tenant), orderBy: { path: 'asc' } })
  if (scope === '') return rows.map(toItem)
  const lower = scope.toLowerCase()
  if (!rows.some((r) => r.path === scope)) return null
  const prefix = `${lower}/`
  return rows
    .filter((r) => {
      const p = r.path.toLowerCase()
      return p === lower || p.startsWith(prefix)
    })
    .map(toItem)
}

export async function saveCursor(
  db: C,
  tenant: string,
  kind: string,
  payload: string,
  minter: Minter,
): Promise<string> {
  const n = minter.next('cursor')
  const token = `${kind}-${String(n)}`
  await db.dropboxCursor.create({ data: { tenant, token, kind, payload, seq: n } })
  return token
}

export async function takeCursor(
  db: C,
  tenant: string,
  token: string,
  kind: string,
): Promise<string | null> {
  const row = await db.dropboxCursor.findUnique({ where: { tenant_token: { tenant, token } } })
  if (row === null || row.kind !== kind) return null
  // A list cursor is consumed; a search cursor is re-read on every page and
  // rewritten by the handler, so only the list side deletes here.
  if (kind === 'list') {
    await db.dropboxCursor.delete({ where: { tenant_token: { tenant, token } } })
  }
  return row.payload
}
