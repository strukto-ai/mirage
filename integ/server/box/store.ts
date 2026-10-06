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
import type { Minter } from '../kit/typescript/index.ts'
import { ID_BASE, ROOT_ID, type C } from './config.ts'
import { eventSource, listOrder, trashedSource, type Item } from './wire.ts'

function key(tenant: string, id: string): { tenant_id: { tenant: string; id: string } } {
  return { tenant_id: { tenant, id } }
}

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

export async function itemById(db: C, tenant: string, id: string): Promise<Item | null> {
  return db.boxItem.findUnique({ where: key(tenant, id) })
}

// Every Box account has an "All Files" root and you cannot create or delete
// it, so it is not data: an account exists the moment a token is presented,
// and its root has to exist just as implicitly. Seeding it per tenant instead
// would mean an account could only be used after a /reset that named it,
// which on a server shared by two hosts is a reset that drops the other's
// data.
export async function ensureRoot(db: C, tenant: string, modified: string): Promise<Item> {
  const found = await db.boxItem.findUnique({ where: key(tenant, ROOT_ID) })
  if (found !== null) return found
  return db.boxItem.create({
    data: {
      tenant,
      id: ROOT_ID,
      type: 'folder',
      name: 'All Files',
      parentId: null,
      modified,
      seq: 0,
    },
  })
}

// A folder lookup that materialises the account root. Every handler that takes
// a folder id goes through this rather than through typedItem, because "0" is
// the one id a caller can name before anything has been written.
export async function folderItem(
  db: C,
  tenant: string,
  id: string,
  modified: string,
): Promise<Item | null> {
  if (id === ROOT_ID) return ensureRoot(db, tenant, modified)
  return typedItem(db, tenant, id, 'folder')
}

export async function typedItem(
  db: C,
  tenant: string,
  id: string,
  type: string,
): Promise<Item | null> {
  const item = await itemById(db, tenant, id)
  return item === null || item.type !== type ? null : item
}

export async function children(db: C, tenant: string, folderId: string): Promise<Item[]> {
  const rows = await db.boxItem.findMany({
    where: { tenant, parentId: folderId },
    orderBy: { seq: 'asc' },
  })
  return rows.sort(listOrder)
}

export async function childByName(
  db: C,
  tenant: string,
  folderId: string,
  name: string,
): Promise<Item | null> {
  const rows = await db.boxItem.findMany({ where: { tenant, parentId: folderId, name } })
  return rows[0] ?? null
}

export async function addFolder(
  db: C,
  tenant: string,
  parentId: string,
  name: string,
  modified: string,
  minter: Minter,
): Promise<Item> {
  return db.boxItem.create({
    data: {
      tenant,
      ...mintRow(minter),
      type: 'folder',
      name,
      parentId,
      modified,
    },
  })
}

export async function addFile(
  db: C,
  tenant: string,
  parentId: string,
  name: string,
  content: Uint8Array<ArrayBuffer>,
  modified: string,
  minter: Minter,
): Promise<Item> {
  return db.boxItem.create({
    data: {
      tenant,
      ...mintRow(minter),
      type: 'file',
      name,
      parentId,
      modified,
      content,
      sha1: sha1Of(content),
      version: 1,
    },
  })
}

export async function addWebLink(
  db: C,
  tenant: string,
  parentId: string,
  name: string,
  url: string,
  modified: string,
  minter: Minter,
): Promise<Item> {
  return db.boxItem.create({
    data: {
      tenant,
      ...mintRow(minter),
      type: 'web_link',
      name,
      parentId,
      modified,
      url,
    },
  })
}

// A new version of an existing file: the vendor keeps the id and advances the
// etag, which is what a client compares to notice a change it did not make.
export async function updateFile(
  db: C,
  tenant: string,
  item: Item,
  content: Uint8Array<ArrayBuffer>,
  modified: string,
): Promise<Item> {
  return db.boxItem.update({
    where: key(tenant, item.id),
    data: { content, sha1: sha1Of(content), version: item.version + 1, modified },
  })
}

// Depth-first, children before the folder itself, so no row is ever orphaned
// mid-delete.
export async function removeTree(db: C, tenant: string, id: string): Promise<void> {
  for (const kid of await children(db, tenant, id)) {
    await removeTree(db, tenant, kid.id)
  }
  await db.boxItem.delete({ where: key(tenant, id) })
}

// The chain from the account root down to the immediate parent, excluding the
// item itself: the vendor's path_collection shape.
export async function ancestors(db: C, tenant: string, item: Item): Promise<Item[]> {
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

export async function isDescendant(
  db: C,
  tenant: string,
  id: string,
  folderId: string,
): Promise<boolean> {
  let cur = await itemById(db, tenant, id)
  while (cur !== null && cur.parentId !== null) {
    if (cur.parentId === folderId) return true
    cur = await itemById(db, tenant, cur.parentId)
  }
  return false
}

export async function copyTree(
  db: C,
  tenant: string,
  src: Item,
  parentId: string,
  name: string,
  modified: string,
  minter: Minter,
): Promise<Item> {
  if (src.type !== 'folder') {
    return addFile(
      db,
      tenant,
      parentId,
      name,
      (src.content ?? new Uint8Array(0)) as Uint8Array<ArrayBuffer>,
      modified,
      minter,
    )
  }
  const made = await addFolder(db, tenant, parentId, name, modified, minter)
  for (const kid of await children(db, tenant, src.id)) {
    await copyTree(db, tenant, kid, made.id, kid.name, modified, minter)
  }
  return made
}

export async function allItems(db: C, tenant: string): Promise<Item[]> {
  return db.boxItem.findMany({ where: { tenant }, orderBy: { seq: 'asc' } })
}

export async function streamHead(db: C, tenant: string): Promise<number> {
  const found = await db.boxEvent.aggregate({ where: { tenant }, _max: { seq: true } })
  return found._max.seq ?? 0
}

// Rendered at the moment of the write, so the source's path_collection is
// where the item is then. Its own counter rather than the minter's: the
// minter numbers item ids, and an event taking a number would make them skip.
export async function recordEvent(
  db: C,
  tenant: string,
  eventType: string,
  item: Item,
  createdAt: string,
): Promise<void> {
  const source =
    eventType === 'ITEM_TRASH'
      ? trashedSource(item)
      : eventSource(item, await ancestors(db, tenant, item))
  await db.boxEvent.create({
    data: {
      tenant,
      seq: (await streamHead(db, tenant)) + 1,
      eventType,
      source: JSON.stringify(source),
      createdAt,
    },
  })
}

export async function eventsAfter(
  db: C,
  tenant: string,
  position: number,
  limit: number,
): Promise<{ seq: number; eventType: string; source: string; createdAt: string }[]> {
  return db.boxEvent.findMany({
    where: { tenant, seq: { gt: position } },
    orderBy: { seq: 'asc' },
    take: limit,
  })
}
