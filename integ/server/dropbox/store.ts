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

import type { DatabaseSync } from 'node:sqlite'
import { BYTES, all, bytes, exec, one } from '../kit/typescript/index.ts'
import type { Minter } from '../kit/typescript/index.ts'
import { dirname, type Item } from './wire.ts'

// The run's file over node:sqlite (kit sql.ts), on the tables
// prisma/dropbox.prisma declares. A Boolean column holds 0 or 1.
type Db = DatabaseSync

interface Row {
  path: string
  isFolder: number
  content: Uint8Array | null
  modified: string | null
  seq: number
}

const ITEM = 'SELECT path, isFolder, content, modified, seq FROM DropboxItem'

// `startsWith` as Prisma ran it on SQLite, which every prefix query here used
// to be: LIKE with the prefix unescaped, so ASCII case is ignored and `%` or
// `_` match as wildcards. Kept exactly.
function like(prefix: string): string {
  return `${prefix}%`
}

function toItem(row: Row): Item {
  return {
    path: row.path,
    isFolder: row.isFolder !== 0,
    content: row.content,
    modified: row.modified,
  }
}

function rowAt(db: Db, tenant: string, path: string): Row | null {
  return one<Row>(db, `${ITEM} WHERE tenant = ? AND path = ?`, tenant, path)
}

function insertItem(
  db: Db,
  tenant: string,
  path: string,
  isFolder: boolean,
  content: Uint8Array | null,
  modified: string | null,
  seq: number,
): void {
  exec(
    db,
    'INSERT INTO DropboxItem (tenant, path, isFolder, content, modified, seq) ' +
      `VALUES (?, ?, ?, ${BYTES}, ?, ?)`,
    tenant,
    path,
    isFolder ? 1 : 0,
    ...bytes(content),
    modified,
    seq,
  )
}

function clearTombstone(db: Db, tenant: string, path: string): void {
  exec(db, 'DELETE FROM DropboxTombstone WHERE tenant = ? AND path = ?', tenant, path)
}

export async function itemAt(db: Db, tenant: string, path: string): Promise<Item | null> {
  if (path === '') return null
  const row = rowAt(db, tenant, path)
  return row === null ? null : toItem(row)
}

// Real Dropbox has no separate mkdir -p: uploading to /a/b/c.txt materialises
// /a and /a/b as folder objects, and a later list_folder on /a has to see /a/b.
// The rows are created rather than upserted per level so an existing folder
// keeps its seq, which is what makes a re-upload leave a listing unchanged.
export async function addAncestors(
  db: Db,
  tenant: string,
  path: string,
  minter: Minter,
): Promise<void> {
  const parts = path.split('/').slice(1, -1)
  let cur = ''
  for (const part of parts) {
    cur += `/${part}`
    if (rowAt(db, tenant, cur) !== null) continue
    insertItem(db, tenant, cur, true, null, null, minter.next('item'))
  }
}

export async function addFolder(
  db: Db,
  tenant: string,
  path: string,
  minter: Minter,
): Promise<Item> {
  await addAncestors(db, tenant, path, minter)
  const seq = minter.next('item')
  insertItem(db, tenant, path, true, null, null, seq)
  clearTombstone(db, tenant, path)
  return { path, isFolder: true, content: null, modified: null }
}

export async function putFile(
  db: Db,
  tenant: string,
  path: string,
  content: Uint8Array,
  modified: string,
  minter: Minter,
): Promise<Item> {
  await addAncestors(db, tenant, path, minter)
  // Prisma's upsert built both its branches before it ran, so a write took
  // two numbers, the first for an update and the second for a create; the
  // counter is shared, so taking one would renumber everything after it.
  const updateSeq = minter.next('item')
  const createSeq = minter.next('item')
  if (rowAt(db, tenant, path) === null) {
    insertItem(db, tenant, path, false, content, modified, createSeq)
  } else {
    exec(
      db,
      `UPDATE DropboxItem SET isFolder = 0, content = ${BYTES}, modified = ?, seq = ? ` +
        'WHERE tenant = ? AND path = ?',
      ...bytes(content),
      modified,
      updateSeq,
      tenant,
      path,
    )
  }
  clearTombstone(db, tenant, path)
  return { path, isFolder: false, content, modified }
}

// null means the path names no folder, which the caller reports as
// path/not_found; an empty array means a real but empty folder.
export async function listChildren(
  db: Db,
  tenant: string,
  path: string,
  recursive: boolean,
): Promise<Item[] | null> {
  if (path !== '') {
    const at = rowAt(db, tenant, path)
    if (at === null || at.isFolder === 0) return null
  }
  const prefix = `${path}/`
  // Paths first, then whole rows for the ones listed: reading every item's
  // content to list one folder cost 11ms a listing. LIKE ignores ASCII case,
  // so the filter below still decides.
  const under = all<{ path: string }>(
    db,
    'SELECT path FROM DropboxItem WHERE tenant = ? AND path LIKE ?',
    tenant,
    like(prefix),
  )
  const listed = under
    .map((r) => r.path)
    .filter((p) => (recursive ? p.startsWith(prefix) : dirname(p) === path))
  const rows =
    listed.length === 0
      ? []
      : all<Row>(
          db,
          `${ITEM} WHERE tenant = ? AND path IN (SELECT value FROM json_each(?))`,
          tenant,
          JSON.stringify(listed),
        )
  const out = rows.map(toItem)
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
  db: Db,
  tenant: string,
  path: string,
  minter: Minter,
): Promise<boolean> {
  const at = rowAt(db, tenant, path)
  if (at === null) return false
  const folder = at.isFolder !== 0
  const doomed = folder
    ? [
        path,
        ...all<{ path: string }>(
          db,
          'SELECT path FROM DropboxItem WHERE tenant = ? AND path LIKE ?',
          tenant,
          like(`${path}/`),
        ).map((row) => row.path),
      ]
    : [path]
  exec(db, 'DELETE FROM DropboxItem WHERE tenant = ? AND path = ?', tenant, path)
  if (folder) {
    exec(db, 'DELETE FROM DropboxItem WHERE tenant = ? AND path LIKE ?', tenant, like(`${path}/`))
  }
  for (const gone of doomed) {
    exec(
      db,
      'INSERT INTO DropboxTombstone (tenant, path, seq) VALUES (?, ?, ?) ' +
        'ON CONFLICT (tenant, path) DO UPDATE SET seq = excluded.seq',
      tenant,
      gone,
      minter.next('item'),
    )
  }
  return true
}

function inScope(itemPath: string, root: string, recursive: boolean): boolean {
  if (root === '') return true
  if (recursive) return itemPath === root || itemPath.startsWith(`${root}/`)
  return dirname(itemPath) === root
}

export async function maxItemSeq(db: Db, tenant: string): Promise<number> {
  const item = one<{ n: number | null }>(
    db,
    'SELECT MAX(seq) AS n FROM DropboxItem WHERE tenant = ?',
    tenant,
  )
  const tomb = one<{ n: number | null }>(
    db,
    'SELECT MAX(seq) AS n FROM DropboxTombstone WHERE tenant = ?',
    tenant,
  )
  return Math.max(item?.n ?? 0, tomb?.n ?? 0)
}

export type Change = { kind: 'item'; item: Item } | { kind: 'deleted'; path: string }

// One stream ordered by seq, not every write and then every delete: a name
// deleted and then moved onto appears in both tables, and writes-first renders
// that as create-then-delete, so a client applying the page in order ends up
// disagreeing with list_folder about a file that is there. The vendor reports
// changes in the order they happened; so does this.
export async function changesSince(
  db: Db,
  tenant: string,
  path: string,
  recursive: boolean,
  seq: number,
): Promise<Change[]> {
  const rows = all<Row>(db, `${ITEM} WHERE tenant = ? AND seq > ?`, tenant, seq)
  const tombs = all<{ path: string; seq: number }>(
    db,
    'SELECT path, seq FROM DropboxTombstone WHERE tenant = ? AND seq > ?',
    tenant,
    seq,
  )
  const stamped: { seq: number; change: Change }[] = [
    ...rows
      .filter((row) => inScope(row.path, path, recursive))
      .map((row) => ({ seq: row.seq, change: { kind: 'item', item: toItem(row) } as Change })),
    ...tombs
      .filter((row) => inScope(row.path, path, recursive))
      .map((row) => ({ seq: row.seq, change: { kind: 'deleted', path: row.path } as Change })),
  ]
  return stamped.sort((a, b) => a.seq - b.seq).map((row) => row.change)
}

// Copies a file or a folder subtree. The caller has already refused a
// conflicting destination, so this only has to place rows.
export async function copyTree(
  db: Db,
  tenant: string,
  from: string,
  to: string,
  minter: Minter,
): Promise<boolean> {
  const src = rowAt(db, tenant, from)
  if (src === null) return false
  await addAncestors(db, tenant, to, minter)
  insertItem(db, tenant, to, src.isFolder !== 0, src.content, src.modified, minter.next('item'))
  // Same rule as putFile and addFolder: a tombstone never names a live
  // path, so moving onto a name that was deleted earlier clears it.
  clearTombstone(db, tenant, to)
  if (src.isFolder === 0) return true
  const under = all<Row>(
    db,
    `${ITEM} WHERE tenant = ? AND path LIKE ? ORDER BY seq`,
    tenant,
    like(`${from}/`),
  )
  for (const row of under) {
    const landed = `${to}${row.path.slice(from.length)}`
    insertItem(
      db,
      tenant,
      landed,
      row.isFolder !== 0,
      row.content,
      row.modified,
      minter.next('item'),
    )
    clearTombstone(db, tenant, landed)
  }
  return true
}

// Scope is a path the search is confined to; '' is the whole account. null
// means the scope names nothing, which the caller reports as path/not_found.
export async function scopedItems(db: Db, tenant: string, scope: string): Promise<Item[] | null> {
  const rows = all<Row>(db, `${ITEM} WHERE tenant = ? ORDER BY path`, tenant)
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
  db: Db,
  tenant: string,
  kind: string,
  payload: string,
  minter: Minter,
): Promise<string> {
  const n = minter.next('cursor')
  const token = `${kind}-${String(n)}`
  exec(
    db,
    'INSERT INTO DropboxCursor (tenant, token, kind, payload, seq) VALUES (?, ?, ?, ?, ?)',
    tenant,
    token,
    kind,
    payload,
    n,
  )
  return token
}

export async function takeCursor(
  db: Db,
  tenant: string,
  token: string,
  kind: string,
): Promise<string | null> {
  const row = one<{ kind: string; payload: string }>(
    db,
    'SELECT kind, payload FROM DropboxCursor WHERE tenant = ? AND token = ?',
    tenant,
    token,
  )
  if (row === null || row.kind !== kind) return null
  // A list cursor is consumed; a search cursor is re-read on every page and
  // rewritten by the handler, so only the list side deletes here.
  if (kind === 'list') {
    exec(db, 'DELETE FROM DropboxCursor WHERE tenant = ? AND token = ?', tenant, token)
  }
  return row.payload
}
