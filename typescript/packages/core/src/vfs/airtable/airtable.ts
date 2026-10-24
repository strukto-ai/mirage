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

import { AirtableAccessor } from '../../accessor/airtable.ts'
import {
  redactAirtableConfig,
  type AirtableConfig,
  type AirtableConfigRedacted,
} from '../../core/airtable/config.ts'
import { VFSName } from '../../types.ts'
import { BaseVFS } from '../base.ts'
import type { Handed } from '../types.ts'
import type { DirListing, PathSpec, FileStat } from '../../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { readdir as airtableReaddir } from '../../core/airtable/readdir.ts'
import {
  firstLines as airtableFirstLines,
  read as airtableRead,
  readStream as airtableStream,
} from '../../core/airtable/read.ts'
import { stat as airtableStat } from '../../core/airtable/stat.ts'
import { buildDeltaHook } from '../../core/airtable/events.ts'
import type { DeltaHook } from '../../events/index.ts'
import { linesContaining as airtableLinesContaining } from '../../core/airtable/search.ts'
import type { ByteSource } from '../../io/types.ts'
import { WALK_LIMIT } from '../constants.ts'

export const VFS_MD = `{prefix}
  bases/
    <base-name>__<base-id>/
      base.json                    base id, name, permission, table list
      <table-name>__<table-id>/
        table.json                 typed fields (with options) and views
        records.jsonl              one record per line
        views/
          <view-name>__<view-id>.jsonl   records the view shows, in its order
  Always ls directories first to discover exact names: the name part of
  a segment is sanitized, the id after the LAST "__" is exact.

  A records.jsonl line is a mirage-normalized record:
    record_id, created_time, and fields (keyed by field NAME, values as
    Airtable returns them). Read table.json for each field's type.
  Airtable omits empty cells, so a missing key means empty (checkbox
  false included). A link field is a list of record ids; an attachment
  url expires two hours after it was read.
  records.jsonl lists in the API's own order; a view file applies the
  view's filter and sort. A file over max_read_records records stops
  with File too large after that many, while head -n N fetches just N
  records:
    head -n 20 {prefix}/bases/<base>/<table>/records.jsonl | jq .fields
  The airtable CLI, if installed, reaches what a file cannot: server-side
  filters (airtable record list --formula or --view), one record by id
  (airtable record get), and comments (airtable comment list).`

export interface AirtableVFSState {
  type: string
  config: AirtableConfigRedacted
}

/**
 * Airtable bases as directories, tables as records.jsonl files. Records are
 * live data another client may edit at any moment, so reads are never served
 * from the file cache; the schema listings still ride the index for its TTL.
 * The transport is plain fetch, so one class serves node and the browser.
 */
export class AirtableVFS extends BaseVFS {
  override readonly name: string = VFSName.AIRTABLE
  override readonly cachesReads: boolean = false
  // records.jsonl and the view files render a paged read, so their size is
  // unknown until the bytes exist.
  override readonly sizesAlwaysKnown: boolean = false
  override readonly supportsSnapshot: boolean = false
  override vfsMd: string = VFS_MD
  override readonly accessor: AirtableAccessor
  override readonly handed = {
    readdir: ['entry'],
    read: ['entry', 'parent'],
    stat: ['entry'],
    linesContaining: ['entry'],
    firstLines: ['entry', 'parent'],
  } as const

  private readonly config: AirtableConfig

  override readonly walkLimit: number
  constructor(config: AirtableConfig, options: { fetchFn?: typeof fetch } = {}) {
    super()
    this.config = config
    this.walkLimit = config.walkLimit ?? WALK_LIMIT
    this.accessor = new AirtableAccessor(config, options)
  }

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return airtableReaddir(this.accessor, path, handed?.entry)
  }

  override async read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> {
    if (offset === 0 && size === null)
      return airtableStream(this.accessor, path, handed?.entry, handed?.parent)
    const data = await airtableRead(this.accessor, path, handed?.entry, handed?.parent)
    return sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return airtableStat(this.accessor, path, handed?.entry)
  }

  override linesContaining(
    path: PathSpec,
    text: string,
    _opts: { ignoreCase: boolean },
    handed?: Handed,
  ): Promise<ByteSource | null> {
    return airtableLinesContaining(this.accessor, path, text, handed?.entry)
  }

  override firstLines(path: PathSpec, n: number, handed?: Handed): Promise<Uint8Array | null> {
    return airtableFirstLines(this.accessor, path, n, handed?.entry, handed?.parent)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): AirtableVFSState {
    return { type: this.name, config: redactAirtableConfig(this.config) }
  }
}
