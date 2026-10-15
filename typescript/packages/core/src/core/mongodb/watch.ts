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
import { enotsup } from '../../errors/fs.ts'
import { Delta, FileChangeKind, FileEvent, type PathSpec } from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { changesUnder } from '../../watch/delta.ts'
import { drainChanges } from './client.ts'
import { detectScope } from './scope.ts'
import {
  CHANGE_STREAM_UNSUPPORTED,
  EntityKind,
  HISTORY_LOST,
  KIND_TO_DIR,
  NOT_A_REPLICA_SET,
  SYSTEM_DATABASES,
} from './types.ts'

// Change events that rewrite a collection's documents.jsonl.
const DATA_EVENTS: ReadonlySet<string> = new Set(['insert', 'update', 'replace', 'delete'])

// Change events that rewrite a collection's schema.json.
const SCHEMA_EVENTS: ReadonlySet<string> = new Set(['createIndexes', 'dropIndexes', 'modify'])

const COLLECTIONS = KIND_TO_DIR[EntityKind.COLLECTION]
const VIEWS = KIND_TO_DIR[EntityKind.VIEW]

function encode(token: unknown): string {
  return JSON.stringify({ mongodb: token ?? {} })
}

/** The stream position a checkpoint holds, null for a baseline. Mirrors Python's `_decode`. */
function decode(checkpoint: string | null): unknown {
  if (checkpoint === null) return null
  const data = JSON.parse(checkpoint) as unknown
  const token =
    typeof data === 'object' && data !== null ? (data as { mongodb?: unknown }).mongodb : null
  return typeof token === 'object' && token !== null && Object.keys(token).length > 0 ? token : null
}

/** Record a directory removed, and forget what changed below it. Mirrors Python's `_removed`. */
function removed(changed: Map<string, FileChangeKind>, place: string): void {
  for (const key of [...changed.keys()]) {
    if (key.startsWith(`${place}/`)) changed.delete(key)
  }
  changed.set(place, FileChangeKind.DELETE)
}

/**
 * Checkpointed delta over a MongoDB change stream. A collection is one
 * documents.jsonl and one schema.json, so the stream says exactly which files
 * moved: a document written or removed rewrites its collection's
 * documents.jsonl and the schema.json sampled from it, and both files of every
 * view in that database (a view reads other collections), an index or validator
 * change its schema.json, a view's new pipeline both of its files (its `modify`
 * names `viewOn`), and a collection created, dropped or renamed is its
 * directory appearing or leaving, and its database's database.json, which lists
 * it. A watch below a directory removed is told its root went (`changesUnder`). The checkpoint is the stream's resume token. A position the
 * server's history no longer holds answers UNKNOWN on the watch root, so
 * everything below is inventoried again. A server outside a replica set has
 * no change stream and refuses the watch. Mirrors Python's MongoDBDeltaHook.
 */
export class MongoDBDeltaHook implements DeltaHook {
  constructor(private readonly accessor: MongoDBAccessor) {}

  async pull(root: PathSpec, checkpoint: string | null): Promise<Delta> {
    const database = detectScope(root).slots.database ?? null
    const token = decode(checkpoint)
    const observed = new Date()
    let events: Record<string, unknown>[]
    let position: unknown
    try {
      ;[events, position] = await drainChanges(this.accessor, database, token)
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (code === CHANGE_STREAM_UNSUPPORTED || code === NOT_A_REPLICA_SET) {
        throw enotsup('mongodb', 'watch', root)
      }
      if (code !== HISTORY_LOST || token === null) throw err
      console.debug(`mongodb watch lost its position: ${String(err)}`)
      const [, fresh] = await drainChanges(this.accessor, database, null)
      const lost = new FileEvent({ kind: FileChangeKind.UNKNOWN, path: root, timestamp: observed })
      return new Delta({ changes: [lost], checkpoint: encode(fresh) })
    }
    if (token === null) return new Delta({ changes: [], checkpoint: encode(position) })
    const changes = await this.changes(root, events, observed)
    return new Delta({ changes, checkpoint: encode(position) })
  }

  /** The files `events` changed under `root`, each once. Mirrors Python's `_changes`. */
  private async changes(
    root: PathSpec,
    events: readonly Record<string, unknown>[],
    observed: Date,
  ): Promise<FileEvent[]> {
    const prefix = mountPrefixOf(root.virtual, root.vfsPath).replace(/\/+$/, '')
    const allowed = this.accessor.config.databases
    const changed = new Map<string, FileChangeKind>()
    const written = new Set<string>()
    for (const event of events) {
      const ns = (event.ns ?? {}) as { db?: unknown; coll?: unknown }
      const db = ns.db
      const name = ns.coll
      if (
        typeof db !== 'string' ||
        SYSTEM_DATABASES.has(db) ||
        (allowed !== null && allowed.length > 0 && !allowed.includes(db))
      ) {
        continue
      }
      const base = `${prefix}/${db}`
      const kind = event.operationType
      if (kind === 'dropDatabase') {
        removed(changed, base)
        continue
      }
      if (typeof name !== 'string') continue
      const place = `${base}/${COLLECTIONS}/${name}`
      const details = (event.operationDescription ?? {}) as Record<string, unknown>
      if (typeof kind === 'string' && DATA_EVENTS.has(kind)) {
        changed.set(`${place}/documents.jsonl`, FileChangeKind.UPDATE)
        changed.set(`${place}/schema.json`, FileChangeKind.UPDATE)
        written.add(db)
      } else if (kind === 'modify' && 'viewOn' in details) {
        const view = `${base}/${VIEWS}/${name}`
        changed.set(`${view}/schema.json`, FileChangeKind.UPDATE)
        changed.set(`${view}/documents.jsonl`, FileChangeKind.UPDATE)
      } else if (typeof kind === 'string' && SCHEMA_EVENTS.has(kind)) {
        changed.set(`${place}/schema.json`, FileChangeKind.UPDATE)
      } else if (kind === 'create') {
        const dirname = 'viewOn' in details ? VIEWS : COLLECTIONS
        changed.set(`${base}/${dirname}/${name}`, FileChangeKind.CREATE)
        changed.set(`${base}/database.json`, FileChangeKind.UPDATE)
      } else if (kind === 'drop') {
        removed(changed, place)
        changed.set(`${base}/${VIEWS}`, FileChangeKind.UNKNOWN)
        changed.set(`${base}/database.json`, FileChangeKind.UPDATE)
      } else if (kind === 'rename') {
        const to = (event.to ?? {}) as { db?: unknown; coll?: unknown }
        removed(changed, place)
        changed.set(`${base}/database.json`, FileChangeKind.UPDATE)
        if (typeof to.db === 'string' && typeof to.coll === 'string') {
          const target = `${prefix}/${to.db}`
          changed.set(`${target}/${COLLECTIONS}/${to.coll}`, FileChangeKind.CREATE)
          changed.set(`${target}/database.json`, FileChangeKind.UPDATE)
        }
      }
    }
    for (const db of [...written].sort(compareCodePoints)) {
      for (const view of await this.accessor.driver.listCollections(db, EntityKind.VIEW)) {
        for (const file of ['documents.jsonl', 'schema.json']) {
          const path = `${prefix}/${db}/${VIEWS}/${view}/${file}`
          if (!changed.has(path)) changed.set(path, FileChangeKind.UPDATE)
        }
      }
    }
    return changesUnder(
      root,
      [...changed].map(([virtual, kind]) => [kind, virtual] as const),
      observed,
    )
  }
}

/** Build the MongoDB delta hook (`MongoDBDeltaHook`). Mirrors Python's `build_delta_hook`. */
export function buildDeltaHook(accessor: MongoDBAccessor): DeltaHook {
  return new MongoDBDeltaHook(accessor)
}
