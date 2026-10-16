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

import type { MongoDBAccessor } from '../../accessor/mongodb.ts'
import { FileChangeKind, type FileEvent, type JsonValue, type PathSpec } from '../../types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { eventAt, field, textField } from '../../events/payload.ts'
import { EntityKind, KIND_TO_DIR, SYSTEM_DATABASES } from './types.ts'

// Change events that rewrite a collection's documents.jsonl.
const DATA_EVENTS: ReadonlySet<string> = new Set(['insert', 'update', 'replace', 'delete'])

// Change events that rewrite a collection's schema.json.
const SCHEMA_EVENTS: ReadonlySet<string> = new Set(['createIndexes', 'dropIndexes', 'modify'])

// Change events that change which collections and views a database lists, so
// its views must be listed again.
const LISTING_EVENTS: ReadonlySet<string> = new Set(['create', 'drop', 'rename', 'modify'])

const COLLECTIONS = KIND_TO_DIR[EntityKind.COLLECTION]
const VIEWS = KIND_TO_DIR[EntityKind.VIEW]

/**
 * Map one MongoDB change stream event onto mount paths.
 *
 * The consumer owns the stream (`watch()` on the client or one database, with
 * `showExpandedEvents` so collection and index changes come through) and its
 * resume token, and passes each event's `operationType` with the event.
 * Nothing here runs a loop.
 *
 * A collection is one `documents.jsonl` and one `schema.json`, so an event
 * says exactly which files moved: a document written or removed rewrites its
 * collection's documents.jsonl and the schema.json sampled from it, and both
 * files of every view in that database (a view reads other collections); an
 * index or validator change rewrites its schema.json, and a view's new
 * pipeline (its `modify` names `viewOn`) both of the view's files; a
 * collection created, dropped or renamed is its directory appearing or
 * leaving, and its database's database.json, which lists it. A dropped
 * database leaves, and an invalidated stream leaves the whole mount UNKNOWN.
 * The views of a database are listed once and listed again after any event
 * that changes what the database holds.
 *
 * Mirrors Python `MongoDBEventHook` (`core/mongodb/events.py`).
 */
export class MongoDBEventHook {
  private readonly accessor: MongoDBAccessor
  private readonly views = new Map<string, string[]>()

  constructor(accessor: MongoDBAccessor) {
    this.accessor = accessor
  }

  /** The views `db` holds, listed once until it changes. */
  private async viewsOf(db: string): Promise<string[]> {
    let found = this.views.get(db)
    if (found === undefined) {
      found = [...(await this.accessor.driver.listCollections(db, EntityKind.VIEW))].sort(
        compareCodePoints,
      )
      this.views.set(db, found)
    }
    return found
  }

  async toEvents(
    root: PathSpec,
    operationType: string,
    payload: JsonValue,
  ): Promise<readonly FileEvent[]> {
    if (operationType === 'invalidate') return [eventAt(root, '', FileChangeKind.UNKNOWN)]
    const ns = field(payload, 'ns') ?? null
    const db = textField(ns, 'db')
    const name = textField(ns, 'coll')
    const allowed = this.accessor.config.databases
    if (
      db === undefined ||
      SYSTEM_DATABASES.has(db) ||
      (allowed !== null && allowed.length > 0 && !allowed.includes(db))
    ) {
      return []
    }
    if (operationType === 'dropDatabase') {
      this.views.delete(db)
      return [eventAt(root, db, FileChangeKind.DELETE)]
    }
    if (name === undefined) return []
    const details = field(payload, 'operationDescription') ?? null
    const changed = new Map<string, FileChangeKind>()
    const place = `${db}/${COLLECTIONS}/${name}`
    if (LISTING_EVENTS.has(operationType)) this.views.delete(db)
    if (DATA_EVENTS.has(operationType)) {
      changed.set(`${place}/documents.jsonl`, FileChangeKind.UPDATE)
      changed.set(`${place}/schema.json`, FileChangeKind.UPDATE)
      for (const view of await this.viewsOf(db)) {
        for (const file of ['documents.jsonl', 'schema.json']) {
          changed.set(`${db}/${VIEWS}/${view}/${file}`, FileChangeKind.UPDATE)
        }
      }
    } else if (operationType === 'modify' && field(details, 'viewOn') !== undefined) {
      const view = `${db}/${VIEWS}/${name}`
      changed.set(`${view}/schema.json`, FileChangeKind.UPDATE)
      changed.set(`${view}/documents.jsonl`, FileChangeKind.UPDATE)
    } else if (SCHEMA_EVENTS.has(operationType)) {
      changed.set(`${place}/schema.json`, FileChangeKind.UPDATE)
    } else if (operationType === 'create') {
      const dirname = field(details, 'viewOn') !== undefined ? VIEWS : COLLECTIONS
      changed.set(`${db}/${dirname}/${name}`, FileChangeKind.CREATE)
      changed.set(`${db}/database.json`, FileChangeKind.UPDATE)
    } else if (operationType === 'drop') {
      changed.set(place, FileChangeKind.DELETE)
      changed.set(`${db}/${VIEWS}`, FileChangeKind.UNKNOWN)
      changed.set(`${db}/database.json`, FileChangeKind.UPDATE)
    } else if (operationType === 'rename') {
      const to = field(payload, 'to') ?? null
      changed.set(place, FileChangeKind.DELETE)
      changed.set(`${db}/database.json`, FileChangeKind.UPDATE)
      const targetDb = textField(to, 'db')
      const target = textField(to, 'coll')
      if (targetDb !== undefined && target !== undefined) {
        this.views.delete(targetDb)
        changed.set(`${targetDb}/${COLLECTIONS}/${target}`, FileChangeKind.CREATE)
        changed.set(`${targetDb}/database.json`, FileChangeKind.UPDATE)
      }
    }
    return [...changed].map(([path, kind]) => eventAt(root, path, kind))
  }
}
