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

import { type ByteSource } from '../../io/types.ts'
import type { NotionAccessor } from '../../accessor/notion.ts'
import {
  firstLines as notionFirstLines,
  readStream as notionStream,
} from '../../core/notion/read.ts'
import { readdir as notionReaddir } from '../../core/notion/readdir.ts'
import { stat as notionStat } from '../../core/notion/stat.ts'
import type { DirListing, FileStat, PathSpec } from '../../types.ts'
import { BaseVFS } from '../base.ts'
import type { Handed } from '../types.ts'

export const VFS_MD = `{prefix}
  pages/
    <page-title>__<page-id>/
      page.json
      <child-page-title>__<child-id>/
        page.json
  databases/
    <database-title>__<database-id>/
      database.json
      <data-source-title>__<data-source-id>/
        data_source.json
        rows.jsonl
  Hierarchical page tree plus shared databases. cat page.json shows
  metadata, the page body rendered as markdown, and raw blocks (nested
  blocks under "children"). A database is a container plus one or more
  data sources: database.json holds the container's identity and its
  data_sources stubs, data_source.json holds the typed property schema,
  and rows.jsonl holds the rows, one JSON line each: the row page's
  page.json without the body, plus "path", that page.json's path below
  the data source dir. Row dirs are not listed; open one by its path.

  Titles are sanitized; don't construct paths: ls the parent dir, or
  take a row's "path" from rows.jsonl.
  ntn takes ids as positional operands, not flags: ntn pages get
  <page-id>, ntn datasources query <data-source-id>, ntn datasources
  resolve <database-id>.`

/**
 * Notion's functions over its accessor, which the node and browser
 * packages build over their own transport.
 */
export class NotionVFSBase extends BaseVFS<NotionAccessor> {
  override readonly handed = {
    readdir: ['entry', 'parent'],
    read: ['parent'],
    firstLines: ['parent'],
    stat: ['entry', 'parent'],
  } as const

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return notionReaddir(this.accessor, path, handed?.entry, handed?.parent)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async read(path: PathSpec, handed?: Handed): Promise<ByteSource> {
    return notionStream(this.accessor, path, handed?.parent)
  }

  override firstLines(path: PathSpec, n: number, handed?: Handed): Promise<Uint8Array | null> {
    return notionFirstLines(this.accessor, path, n, handed?.parent)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return notionStat(this.accessor, path, handed?.entry, handed?.parent)
  }
}
