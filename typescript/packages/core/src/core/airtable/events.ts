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

import type { AirtableAccessor } from '../../accessor/airtable.ts'
import { Delta, FileChangeKind, FileEvent, type JsonValue, type PathSpec } from '../../types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { DeltaHook } from '../../events/base.ts'
import { eventsUnder } from '../../events/delta.ts'
import { eventAt, textField } from '../../events/payload.ts'
import { listBases, listTables, listWebhooks, webhookPayloads } from './client.ts'
import { AirtableApiError } from './errors.ts'
import { asRow, asRows, type Row } from './normalize.ts'
import { baseDirname, tableDirname } from './pathing.ts'
import { detectScope } from './scope.ts'

// The table changes a records.jsonl renders: its records, and its fields,
// which key every record's cells.
const RECORD_KEYS = [
  'createdRecordsById',
  'changedRecordsById',
  'destroyedRecordIds',
  'createdFieldsById',
  'changedFieldsById',
  'destroyedFieldIds',
] as const

// The table changes a table.json renders.
const SCHEMA_KEYS = [
  'createdFieldsById',
  'changedFieldsById',
  'destroyedFieldIds',
  'changedMetadata',
] as const

/**
 * What a pull keeps for one base: its directory, each webhook's next cursor,
 * and each table's directory.
 *
 * Mirrors Python `_BaseFeed` (`core/airtable/events.py`).
 */
interface BaseFeed {
  dir: string
  hooks: Record<string, number>
  tables: Record<string, string>
}

function encode(feeds: Readonly<Record<string, BaseFeed>>): string {
  const airtable: Record<string, BaseFeed> = {}
  for (const [baseId, feed] of Object.entries(feeds).sort(([a], [b]) => compareCodePoints(a, b))) {
    airtable[baseId] = {
      dir: feed.dir,
      hooks: Object.fromEntries(
        Object.entries(feed.hooks).sort(([a], [b]) => compareCodePoints(a, b)),
      ),
      tables: Object.fromEntries(
        Object.entries(feed.tables).sort(([a], [b]) => compareCodePoints(a, b)),
      ),
    }
  }
  return JSON.stringify({ airtable })
}

/**
 * The bases a checkpoint keeps, null for a baseline.
 *
 * Mirrors Python `_decode` (`core/airtable/events.py`).
 */
function decode(checkpoint: string | null): Record<string, BaseFeed> | null {
  if (checkpoint === null) return null
  const state = asRow(asRow(JSON.parse(checkpoint) as unknown).airtable)
  const feeds: Record<string, BaseFeed> = {}
  for (const [baseId, value] of Object.entries(state)) {
    const feed = asRow(value)
    feeds[baseId] = {
      dir: String(feed.dir),
      hooks: Object.fromEntries(Object.entries(asRow(feed.hooks)).map(([k, v]) => [k, Number(v)])),
      tables: Object.fromEntries(
        Object.entries(asRow(feed.tables)).map(([k, v]) => [k, String(v)]),
      ),
    }
  }
  return feeds
}

/**
 * The changes a pull found, each once, in the order found.
 *
 * Mirrors Python `_Changes` (`core/airtable/events.py`).
 */
class Changes {
  readonly found = new Map<string, [FileChangeKind, string]>()
  lost = false

  add(kind: FileChangeKind, path: string): void {
    this.found.set(`${kind}\u0000${path}`, [kind, path])
  }
}

/**
 * What changed in the Airtable bases under an event root since the last
 * cursors, for the consumer to call when Airtable pings.
 *
 * An Airtable webhook's notification names the base, the webhook and a time,
 * never the change, so each ping is answered by reading, for every webhook on
 * each base the root covers, its `payloads` from the cursor the last pull
 * kept. The bases are those the root names, or the account's (`listBases`)
 * when the root is above them, as `readdir` lists them. A baseline takes each
 * webhook's `cursorForNextPayload` and each base's table names and reports
 * nothing. A webhook made after the last pull is read from its first payload,
 * and a base the last pull did not cover is UNKNOWN.
 *
 * A payload names tables by id, so the checkpoint keeps each table's
 * directory, named from the base schema the first time and kept current by
 * the renames the payloads carry. A record or field change updates the
 * table's `records.jsonl`, and a field or description change its
 * `table.json`; which saved views show a record is the view's own filter, so
 * a table's `views` is UNKNOWN when its records change. A table made, renamed
 * or destroyed also updates `base.json`, which lists the tables; a renamed
 * table moves everything below it, so its old and new directory are UNKNOWN.
 *
 * Airtable keeps payloads for seven days, and a cursor older than that reads
 * from the oldest left, which shows as a later cursor than the payloads read
 * account for. That, a webhook the last pull read that is gone, and a payload
 * marked `error` all mean changes were lost, so the event root is UNKNOWN and
 * the base's table names are read from its schema again.
 *
 * Mirrors Python `AirtableDeltaHook` (`core/airtable/events.py`).
 */
export class AirtableDeltaHook implements DeltaHook {
  private readonly accessor: AirtableAccessor

  constructor(accessor: AirtableAccessor) {
    this.accessor = accessor
  }

  private async bases(root: PathSpec): Promise<Record<string, string>> {
    const baseId = detectScope(root.vfsPath).slots.base_id
    if (baseId !== undefined) {
      const wanted = this.accessor.baseIds
      if (wanted !== null && !wanted.includes(baseId)) return {}
      return { [baseId]: stripSlash(root.vfsPath).split('/')[1] ?? '' }
    }
    const out: Record<string, string> = {}
    for (const base of await listBases(this.accessor)) out[String(base.id)] = baseDirname(base)
    return out
  }

  private async tables(baseId: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const table of await listTables(this.accessor, baseId)) {
      out[String(table.id)] = tableDirname(table)
    }
    return out
  }

  private async present(baseId: string, baseDir: string): Promise<BaseFeed> {
    const hooks: Record<string, number> = {}
    for (const hook of await listWebhooks(this.accessor, baseId)) {
      const next = hook.cursorForNextPayload
      hooks[String(hook.id)] = typeof next === 'number' && next !== 0 ? next : 1
    }
    return { dir: baseDir, hooks, tables: await this.tables(baseId) }
  }

  private async payloads(
    baseId: string,
    hookId: string,
    from: number,
  ): Promise<{ found: Row[]; cursor: number | null; lost: boolean }> {
    const found: Row[] = []
    let cursor = from
    let lost = false
    for (;;) {
      let page: Row
      try {
        page = await webhookPayloads(this.accessor, baseId, hookId, cursor)
      } catch (err) {
        if (!(err instanceof AirtableApiError) || !err.notFound) throw err
        console.debug(`airtable webhook ${hookId} is gone: ${err.message}`)
        return { found, cursor: null, lost: true }
      }
      const rows = asRows(page.payloads)
      found.push(...rows)
      const after = page.cursor
      if (typeof after !== 'number' || !Number.isInteger(after)) return { found, cursor, lost }
      if (after - cursor > rows.length) lost = true
      const more = page.mightHaveMore === true && after !== cursor
      cursor = after
      if (!more) return { found, cursor, lost }
    }
  }

  // Add the changes one payload names, and say whether it is the error payload
  // a webhook leaves when it lost changes.
  private async map(
    baseId: string,
    feed: BaseFeed,
    payload: Row,
    changes: Changes,
  ): Promise<boolean> {
    if (payload.error === true) return true
    const base = `bases/${feed.dir}`
    for (const [tableId, made] of Object.entries(asRow(payload.createdTablesById))) {
      const name = textField(asRow(asRow(made).metadata) as JsonValue, 'name')
      const madeDir = `${base}/` + tableDirname({ id: tableId, name: name ?? null })
      feed.tables[tableId] = madeDir.slice(madeDir.lastIndexOf('/') + 1)
      changes.add(FileChangeKind.CREATE, `${madeDir}/table.json`)
      changes.add(FileChangeKind.CREATE, `${madeDir}/records.jsonl`)
      changes.add(FileChangeKind.UNKNOWN, `${madeDir}/views`)
      changes.add(FileChangeKind.UPDATE, `${base}/base.json`)
    }
    const destroyed = payload.destroyedTableIds
    for (const tableId of Array.isArray(destroyed) ? destroyed : []) {
      const key = String(tableId)
      const gone = feed.tables[key] ?? ''
      Reflect.deleteProperty(feed.tables, key)
      if (gone !== '') changes.add(FileChangeKind.DELETE, `${base}/${gone}`)
      else changes.add(FileChangeKind.UNKNOWN, base)
      changes.add(FileChangeKind.UPDATE, `${base}/base.json`)
    }
    for (const [tableId, changed] of Object.entries(asRow(payload.changedTablesById))) {
      const body = asRow(changed)
      let table = feed.tables[tableId]
      if (table === undefined) {
        Object.assign(feed.tables, await this.tables(baseId))
        table = feed.tables[tableId]
      }
      const renamed = textField(asRow(asRow(body.changedMetadata).current) as JsonValue, 'name')
      if (renamed !== undefined) {
        const now = tableDirname({ id: tableId, name: renamed })
        if (table !== undefined && table !== now) {
          changes.add(FileChangeKind.UNKNOWN, `${base}/${table}`)
        }
        feed.tables[tableId] = now
        changes.add(FileChangeKind.UNKNOWN, `${base}/${now}`)
        changes.add(FileChangeKind.UPDATE, `${base}/base.json`)
        continue
      }
      if (table === undefined) {
        changes.add(FileChangeKind.UNKNOWN, base)
        continue
      }
      const where = `${base}/${table}`
      if (SCHEMA_KEYS.some((key) => (body[key] ?? null) !== null)) {
        changes.add(FileChangeKind.UPDATE, `${where}/table.json`)
      }
      if (RECORD_KEYS.some((key) => (body[key] ?? null) !== null)) {
        changes.add(FileChangeKind.UPDATE, `${where}/records.jsonl`)
        changes.add(FileChangeKind.UNKNOWN, `${where}/views`)
      } else if ((body.changedViewsById ?? null) !== null) {
        changes.add(FileChangeKind.UNKNOWN, `${where}/views`)
      }
    }
    return false
  }

  // Read each of a base's webhooks from its kept cursor, and one first seen since
  // from its first payload, so a new webhook whose first payloads expired lost
  // them too. A lost payload may have made, renamed or destroyed a table, so a
  // base that lost any names its tables from the schema again.
  private async read(
    baseId: string,
    feed: BaseFeed,
    was: Readonly<Record<string, number>>,
    changes: Changes,
  ): Promise<void> {
    const listed = (await listWebhooks(this.accessor, baseId)).map((hook) => String(hook.id))
    let lost = Object.keys(was).some((hookId) => !listed.includes(hookId))
    for (const hookId of listed) {
      const read = await this.payloads(baseId, hookId, was[hookId] ?? 1)
      lost = lost || read.lost
      for (const payload of read.found) {
        lost = (await this.map(baseId, feed, payload, changes)) || lost
      }
      if (read.cursor !== null) feed.hooks[hookId] = read.cursor
    }
    if (lost) {
      feed.tables = await this.tables(baseId)
      changes.lost = true
    }
  }

  async pull(root: PathSpec, checkpoint: string | null): Promise<Delta> {
    const state = decode(checkpoint)
    const observed = new Date()
    const bases = await this.bases(root)
    if (state === null) {
      const feeds: Record<string, BaseFeed> = {}
      for (const [baseId, baseDir] of Object.entries(bases)) {
        feeds[baseId] = await this.present(baseId, baseDir)
      }
      return new Delta({ changes: [], checkpoint: encode(feeds) })
    }
    const changes = new Changes()
    const feeds: Record<string, BaseFeed> = {}
    for (const [baseId, baseDir] of Object.entries(bases)) {
      const kept = state[baseId]
      if (kept === undefined) {
        feeds[baseId] = await this.present(baseId, baseDir)
        changes.add(FileChangeKind.UNKNOWN, `bases/${baseDir}`)
        continue
      }
      if (kept.dir !== baseDir) {
        changes.add(FileChangeKind.UNKNOWN, `bases/${kept.dir}`)
        changes.add(FileChangeKind.UNKNOWN, `bases/${baseDir}`)
      }
      const feed: BaseFeed = { dir: baseDir, hooks: {}, tables: { ...kept.tables } }
      await this.read(baseId, feed, kept.hooks, changes)
      feeds[baseId] = feed
    }
    for (const [baseId, kept] of Object.entries(state)) {
      if (!(baseId in bases)) changes.add(FileChangeKind.DELETE, `bases/${kept.dir}`)
    }
    const events = eventsUnder(
      root,
      [...changes.found.values()].map(([kind, path]) => eventAt(root, path, kind)),
    )
    if (changes.lost) {
      events.unshift(
        new FileEvent({ kind: FileChangeKind.UNKNOWN, path: root, timestamp: observed }),
      )
    }
    return new Delta({ changes: events, checkpoint: encode(feeds) })
  }
}

/** Build the Airtable delta hook. Mirrors Python `build_delta_hook`. */
export function buildDeltaHook(accessor: AirtableAccessor): DeltaHook {
  return new AirtableDeltaHook(accessor)
}
