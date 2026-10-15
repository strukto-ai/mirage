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

import {
  FileChangeKind,
  type FileEvent,
  type JsonValue,
  type PathSpec,
} from '@struktoai/mirage-core/types'
import { normalize } from '@struktoai/mirage-core/utils/key_prefix'
import { eventAt, field, textField } from '@struktoai/mirage-core/watch/index'
import type { GridFSAccessor } from '../../accessor/gridfs.ts'
import { filesColl } from './client.ts'

// Events after which the stream no longer describes the files collection
// document by document.
const GONE = new Set(['drop', 'dropDatabase', 'rename', 'invalidate'])

/**
 * Map one change stream event on a bucket's files collection onto mount
 * paths.
 *
 * The consumer owns the stream (`watch()` on `<bucket>.files`, ideally with
 * `fullDocumentBeforeChange` so a delete names its file) and its resume token,
 * and passes each event's `operationType` with the event. Nothing here runs a
 * loop.
 *
 * GridFS keeps every upload as its own revision and serves the newest, so
 * after an insert, a delete or a rename the hook counts the revisions left
 * under each name it touched: none is a DELETE, one just made is a CREATE, and
 * any other is an UPDATE, since the file now reads another revision. A delete
 * names its document by id only; the pre-image, or the insert the hook saw,
 * names the file, and with neither the whole mount is UNKNOWN. A filename
 * ending in `/` is a directory marker. A dropped or renamed collection, a
 * dropped database and an invalidated stream leave the mount UNKNOWN.
 *
 * Mirrors Python `GridFSEventHook` (`core/gridfs/watch.py`).
 */
export class GridFSEventHook {
  private readonly accessor: GridFSAccessor
  private readonly names = new Map<string, string>()

  constructor(accessor: GridFSAccessor) {
    this.accessor = accessor
  }

  /** The mount-relative path of a filename, or null outside the key prefix. */
  private relative(filename: string): string | null {
    const prefix = normalize(this.accessor.config.keyPrefix)
    if (prefix !== '' && !filename.startsWith(prefix)) return null
    return filename.slice(prefix.length)
  }

  /** The change `filename` now reads as, from the revisions left. */
  private async settled(root: PathSpec, filename: string, made: boolean): Promise<FileEvent[]> {
    const relative = this.relative(filename)
    if (relative === null) return []
    if (relative.endsWith('/')) {
      const kind = made ? FileChangeKind.CREATE : FileChangeKind.UNKNOWN
      return [eventAt(root, relative.replace(/\/+$/, ''), kind)]
    }
    const files = await filesColl(this.accessor)
    const left = await files.countDocuments({ filename }, { limit: 2 })
    const kind =
      left === 0
        ? FileChangeKind.DELETE
        : made && left === 1
          ? FileChangeKind.CREATE
          : FileChangeKind.UPDATE
    return [eventAt(root, relative, kind)]
  }

  async toEvents(
    root: PathSpec,
    operationType: string,
    payload: JsonValue,
  ): Promise<readonly FileEvent[]> {
    const config = this.accessor.config
    const ns = field(payload, 'ns') ?? null
    if (operationType === 'invalidate') return [eventAt(root, '', FileChangeKind.UNKNOWN)]
    const coll = textField(ns, 'coll')
    if (
      textField(ns, 'db') !== config.database ||
      (coll !== undefined && coll !== `${config.bucket ?? 'fs'}.files`)
    ) {
      return []
    }
    if (GONE.has(operationType)) return [eventAt(root, '', FileChangeKind.UNKNOWN)]
    const ident = JSON.stringify(field(field(payload, 'documentKey') ?? null, '_id') ?? null)
    const before =
      textField(field(payload, 'fullDocumentBeforeChange') ?? null, 'filename') ??
      this.names.get(ident)
    const after =
      textField(field(payload, 'fullDocument') ?? null, 'filename') ??
      textField(
        field(field(payload, 'updateDescription') ?? null, 'updatedFields') ?? null,
        'filename',
      )
    if (operationType === 'insert' && after !== undefined) {
      this.names.set(ident, after)
      return this.settled(root, after, true)
    }
    if (operationType === 'delete') {
      this.names.delete(ident)
      if (before === undefined) return [eventAt(root, '', FileChangeKind.UNKNOWN)]
      return this.settled(root, before, false)
    }
    if (operationType !== 'update' && operationType !== 'replace') return []
    if (before === undefined) {
      if (after !== undefined) this.names.set(ident, after)
      return [eventAt(root, '', FileChangeKind.UNKNOWN)]
    }
    if (after === undefined || after === before) return this.settled(root, before, false)
    this.names.set(ident, after)
    return [
      ...(await this.settled(root, before, false)),
      ...(await this.settled(root, after, true)),
    ]
  }
}
