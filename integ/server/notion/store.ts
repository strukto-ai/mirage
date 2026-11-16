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

import { first, select } from '../kit/typescript/index.ts'
import type { NotionBlock, NotionDatabase, NotionMeta } from '../../generated/notion/index.js'
import type { DatabaseSync } from 'node:sqlite'
import { Prisma } from '../../generated/notion/index.js'
import type { Dmmf } from '../kit/typescript/index.ts'
import { blockToMd } from './text.ts'
import type { BlockRow, DatabaseRow, MetaRow } from './types.ts'
import { databaseIdOf } from './wire.ts'

// The run's file over node:sqlite (kit sql.ts), on the tables
// prisma/notion.prisma declares; the kit's `select` types every column from
// this schema, so rows come back as Prisma's findMany returned them.
export type Db = DatabaseSync
export const DMMF = Prisma.dmmf as unknown as Dmmf

export async function metaOf(db: Db, tenant: string): Promise<MetaRow> {
  const row = first<NotionMeta>(db, DMMF, 'NotionMeta', '"tenant" = ?', tenant)
  if (row === null) throw new Error(`notion fake: no meta row for tenant ${tenant}`)
  return row
}

// The database a data source id belongs to. The fake derives one data source
// per database, so this is `dataSourceIdOf` run backwards over every database.
export async function dataSourceOwner(
  db: Db,
  tenant: string,
  dataSourceId: string,
): Promise<DatabaseRow | null> {
  const all = select<NotionDatabase>(
    db,
    DMMF,
    'NotionDatabase',
    '"tenant" = ?',
    tenant,
  ) as DatabaseRow[]
  const owner = databaseIdOf(dataSourceId, all)
  return all.find((row) => row.id === owner) ?? null
}

export async function childrenOf(db: Db, tenant: string, parentId: string): Promise<BlockRow[]> {
  return select<NotionBlock>(
    db,
    DMMF,
    'NotionBlock',
    '"tenant" = ? AND "parentId" = ? AND "inTrash" = ? ORDER BY "position" ASC',
    tenant,
    parentId,
    false,
  ) as BlockRow[]
}

export async function markdownOf(
  db: Db,
  tenant: string,
  parentId: string,
  indent: number,
  lines: string[],
): Promise<void> {
  for (const row of await childrenOf(db, tenant, parentId)) {
    const line = blockToMd(row, indent)
    if (line !== '') lines.push(line)
    if (row.hasChildren) await markdownOf(db, tenant, row.id, indent + 1, lines)
  }
}

// The inverse, for POST /v1/pages {markdown}: the official CLI's
