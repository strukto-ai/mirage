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

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { BYTES, all, bytes, exec, one } from '../kit/typescript/index.ts'
import type { Minter } from '../kit/typescript/index.ts'
import { ID_BASE, ROOT_ID } from './config.ts'
import { eventSource, listOrder, trashedSource, type Item } from './wire.ts'

// The run's file over node:sqlite (kit sql.ts), on the tables
// prisma/box.prisma declares. Rows come back with every column in the
// schema's order, as Prisma returned them.
type Db = DatabaseSync

const ITEM =
  'SELECT tenant, id, type, name, parentId, modified, content, sha1, version, url, ' +
  'extractedText, seq FROM BoxItem'

export function sha1Of(content: Uint8Array): string {
  return createHash('sha1').update(content).digest('hex')
}

// One mint per row, used for BOTH the id and the seq: the minter shares one
// counter across kinds, so minting twice per row made every id skip a number
// and the vendor's ids are consecutive.
export function mintRow(minter: Minter): { id: string; seq: number } {
  const n = minter.next('item')
  return { id: String(ID_BASE + n), seq: n }
}

export async function itemById(db: Db, tenant: string, id: string): Promise<Item | null> {
  return one<Item>(db, `${ITEM} WHERE tenant = ? AND id = ?`, tenant, id)
}

interface NewItem {
  id: string
  seq: number
  type: string
  name: string
  parentId: string | null
  modified: string
  content?: Uint8Array | null
  sha1?: string | null
  url?: string | null
}

// A new row with the schema's defaults for what it does not name, read back
// whole as Prisma's create answered it.
async function insertItem(db: Db, tenant: string, row: NewItem): Promise<Item> {
  exec(
    db,
    'INSERT INTO BoxItem (tenant, id, type, name, parentId, modified, content, sha1, url, seq) ' +
      `VALUES (?, ?, ?, ?, ?, ?, ${BYTES}, ?, ?, ?)`,
    tenant,
    row.id,
    row.type,
    row.name,
    row.parentId,
    row.modified,
    ...bytes(row.content ?? null),
    row.sha1 ?? null,
    row.url ?? null,
    row.seq,
  )
  const made = await itemById(db, tenant, row.id)
  if (made === null) throw new Error(`box fake: item ${row.id} vanished as it was written`)
  return made
}

// Every Box account has an "All Files" root and you cannot create or delete
// it, so it is not data: an account exists the moment a token is presented,
// and its root has to exist just as implicitly. Seeding it per tenant instead
// would mean an account could only be used after a /reset that named it,
// which on a server shared by two hosts is a reset that drops the other's
// data.
export async function ensureRoot(db: Db, tenant: string, modified: string): Promise<Item> {
  const found = await itemById(db, tenant, ROOT_ID)
  if (found !== null) return found
  return insertItem(db, tenant, {
    id: ROOT_ID,
    seq: 0,
    type: 'folder',
    name: 'All Files',
    parentId: null,
    modified,
  })
}

// A folder lookup that materialises the account root. Every handler that takes
// a folder id goes through this rather than through typedItem, because "0" is
// the one id a caller can name before anything has been written.
export async function folderItem(
  db: Db,
  tenant: string,
  id: string,
  modified: string,
): Promise<Item | null> {
  if (id === ROOT_ID) return ensureRoot(db, tenant, modified)
  return typedItem(db, tenant, id, 'folder')
}

export async function typedItem(
  db: Db,
  tenant: string,
  id: string,
  type: string,
): Promise<Item | null> {
  const item = await itemById(db, tenant, id)
  return item === null || item.type !== type ? null : item
}

export async function children(db: Db, tenant: string, folderId: string): Promise<Item[]> {
  const rows = all<Item>(
    db,
    `${ITEM} WHERE tenant = ? AND parentId = ? ORDER BY seq`,
    tenant,
    folderId,
  )
  return rows.sort(listOrder)
}

export async function childByName(
  db: Db,
  tenant: string,
  folderId: string,
  name: string,
): Promise<Item | null> {
  return one<Item>(
    db,
    `${ITEM} WHERE tenant = ? AND parentId = ? AND name = ?`,
    tenant,
    folderId,
    name,
  )
}

export async function addFolder(
  db: Db,
  tenant: string,
  parentId: string,
  name: string,
  modified: string,
  minter: Minter,
): Promise<Item> {
  return insertItem(db, tenant, { ...mintRow(minter), type: 'folder', name, parentId, modified })
}

export async function addFile(
  db: Db,
  tenant: string,
  parentId: string,
  name: string,
  content: Uint8Array,
  modified: string,
  minter: Minter,
): Promise<Item> {
  return insertItem(db, tenant, {
    ...mintRow(minter),
    type: 'file',
    name,
    parentId,
    modified,
    content,
    sha1: sha1Of(content),
  })
}

export async function addWebLink(
  db: Db,
  tenant: string,
  parentId: string,
  name: string,
  url: string,
  modified: string,
  minter: Minter,
): Promise<Item> {
  return insertItem(db, tenant, {
    ...mintRow(minter),
    type: 'web_link',
    name,
    parentId,
    modified,
    url,
  })
}

async function reread(db: Db, tenant: string, id: string): Promise<Item> {
  const item = await itemById(db, tenant, id)
  if (item === null) throw new Error(`box fake: item ${id} vanished as it was updated`)
  return item
}

// A new version of an existing file: the vendor keeps the id and advances the
// etag, which is what a client compares to notice a change it did not make.
export async function updateFile(
  db: Db,
  tenant: string,
  item: Item,
  content: Uint8Array,
  modified: string,
): Promise<Item> {
  exec(
    db,
    `UPDATE BoxItem SET content = ${BYTES}, sha1 = ?, version = ?, modified = ? ` +
      'WHERE tenant = ? AND id = ?',
    ...bytes(content),
    sha1Of(content),
    item.version + 1,
    modified,
    tenant,
    item.id,
  )
  return reread(db, tenant, item.id)
}

// The vendor's rename and move, which change only these three columns.
export async function moveItem(
  db: Db,
  tenant: string,
  id: string,
  name: string,
  parentId: string,
  modified: string,
): Promise<Item> {
  exec(
    db,
    'UPDATE BoxItem SET name = ?, parentId = ?, modified = ? WHERE tenant = ? AND id = ?',
    name,
    parentId,
    modified,
    tenant,
    id,
  )
  return reread(db, tenant, id)
}

// Depth-first, children before the folder itself, so no row is ever orphaned
// mid-delete.
export async function removeTree(db: Db, tenant: string, id: string): Promise<void> {
  for (const kid of await children(db, tenant, id)) {
    await removeTree(db, tenant, kid.id)
  }
  if ((await itemById(db, tenant, id)) === null) {
    throw new Error(`box fake: item ${id} is already gone`)
  }
  exec(db, 'DELETE FROM BoxItem WHERE tenant = ? AND id = ?', tenant, id)
}

// The chain from the account root down to the immediate parent, excluding the
// item itself: the vendor's path_collection shape.
export async function ancestors(db: Db, tenant: string, item: Item): Promise<Item[]> {
  const chain: Item[] = []
  let cur = item
  while (cur.parentId !== null) {
    const parent = await itemById(db, tenant, cur.parentId)
    if (parent === null) break
    chain.push(parent)
    cur = parent
  }
  return chain.reverse()
}

export async function copyTree(
  db: Db,
  tenant: string,
  src: Item,
  parentId: string,
  name: string,
  modified: string,
  minter: Minter,
): Promise<Item> {
  if (src.type !== 'folder') {
    return addFile(db, tenant, parentId, name, src.content ?? new Uint8Array(0), modified, minter)
  }
  const made = await addFolder(db, tenant, parentId, name, modified, minter)
  for (const kid of await children(db, tenant, src.id)) {
    await copyTree(db, tenant, kid, made.id, kid.name, modified, minter)
  }
  return made
}

export async function allItems(db: Db, tenant: string): Promise<Item[]> {
  return all<Item>(db, `${ITEM} WHERE tenant = ? ORDER BY seq`, tenant)
}

export async function streamHead(db: Db, tenant: string): Promise<number> {
  const found = one<{ n: number | null }>(
    db,
    'SELECT MAX(seq) AS n FROM BoxEvent WHERE tenant = ?',
    tenant,
  )
  return found?.n ?? 0
}

// Rendered at the moment of the write, so the source's path_collection is
// where the item is then. Its own counter rather than the minter's: the
// minter numbers item ids, and an event taking a number would make them skip.
export async function recordEvent(
  db: Db,
  tenant: string,
  eventType: string,
  item: Item,
  createdAt: string,
): Promise<void> {
  const source =
    eventType === 'ITEM_TRASH'
      ? trashedSource(item)
      : eventSource(item, await ancestors(db, tenant, item))
  exec(
    db,
    'INSERT INTO BoxEvent (tenant, seq, eventType, source, createdAt) VALUES (?, ?, ?, ?, ?)',
    tenant,
    (await streamHead(db, tenant)) + 1,
    eventType,
    JSON.stringify(source),
    createdAt,
  )
}

export async function eventsAfter(
  db: Db,
  tenant: string,
  position: number,
  limit: number,
): Promise<{ seq: number; eventType: string; source: string; createdAt: string }[]> {
  return all(
    db,
    'SELECT tenant, seq, eventType, source, createdAt FROM BoxEvent ' +
      'WHERE tenant = ? AND seq > ? ORDER BY seq LIMIT ?',
    tenant,
    position,
    limit,
  )
}
