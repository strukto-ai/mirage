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

import type { NotionAccessor } from '../../accessor/notion.ts'
import { FileChangeKind, type FileEvent, type JsonValue, type PathSpec } from '../../types.ts'
import { eventAt, field, textField } from '../../events/payload.ts'
import { underPath } from '../../utils/key_prefix.ts'
import { NotionAPIError, type NotionTransport } from './client.ts'
import { dataSourceSegmentName, databaseSegmentName, pageSegmentName } from './normalize.ts'
import { getDataSource, getDatabase, getPage } from './pages.ts'

const GONE: ReadonlySet<string> = new Set([
  'page.deleted',
  'database.deleted',
  'data_source.deleted',
])
const MADE: ReadonlySet<string> = new Set([
  'page.created',
  'page.undeleted',
  'database.created',
  'database.undeleted',
  'data_source.created',
  'data_source.undeleted',
])
const PLACED: ReadonlySet<string> = new Set([
  'page.properties_updated',
  'page.moved',
  'database.moved',
  'database.schema_updated',
  'data_source.moved',
  'data_source.schema_updated',
])
const OWN_FILES: Readonly<Record<string, readonly string[]>> = {
  page: ['page.json'],
  database: ['database.json'],
  data_source: ['data_source.json', 'rows.jsonl'],
}

/**
 * The `rows.jsonl` a page's directory is a row of, or null.
 *
 * A row is the only page directly below a data source, which is the only
 * directory two levels below `databases`.
 *
 * Mirrors Python `_rows_of` (`core/notion/events.py`).
 */
function rowsOf(place: string | null): string | null {
  if (place === null) return null
  const parts = place.split('/')
  if (parts.length !== 4 || parts[0] !== 'databases') return null
  return `${parts.slice(0, 3).join('/')}/rows.jsonl`
}

/**
 * The directory holding `place`.
 *
 * Mirrors Python `_parent` (`core/notion/events.py`).
 */
function parent(place: string): string {
  return place.slice(0, place.lastIndexOf('/'))
}

/**
 * Map one Notion webhook event onto mount paths.
 *
 * The consumer owns the subscription's endpoint and passes the event's `type`
 * with its body. Nothing here runs a loop. An event names its entity by id
 * only, so each place is read from Notion: a page by its parent chain up to
 * the workspace or a data source, a data source through its database. Each
 * place is remembered, so a later event on the same page or one below it costs
 * nothing, and a move, rename or delete forgets what was below the old place.
 *
 * A page is a directory holding `page.json`, below `pages` when it is a
 * workspace page, below another page, or below a data source as a row. A page
 * inside some other block is not listed, so it maps to nothing, as does one
 * the integration cannot read up to the top. `page.json` renders the page's
 * properties and blocks, so a content or property change updates it, and a
 * row's line in its data source's `rows.jsonl` carries the same properties
 * and edit time.
 *
 * A page made or restored creates its `page.json`, and one deleted deletes its
 * directory. A page's directory carries its title, so a move or a retitle
 * moves everything below it, which the event does not list: the old place,
 * when the hook saw it, and the new one are UNKNOWN. A move of one it never
 * saw has an old place nothing names, so the whole mount is UNKNOWN, and a
 * retitle of a page it never saw is UNKNOWN on the page's parent. Databases and data sources
 * follow the same rules with `database.json` and `data_source.json`; a data
 * source's rows changing updates `rows.jsonl`, and a database lists its data
 * sources, so a data source made, moved, retitled or deleted also updates
 * `database.json`. Comments are rendered nowhere.
 *
 * Mirrors Python `NotionEventHook` (`core/notion/events.py`).
 */
export class NotionEventHook {
  private readonly accessor: NotionAccessor
  private readonly places = new Map<string, string | null>()

  constructor(accessor: NotionAccessor) {
    this.accessor = accessor
  }

  private async read(
    get: (transport: NotionTransport, id: string) => Promise<Record<string, unknown>>,
    objectId: string,
  ): Promise<JsonValue> {
    try {
      return (await get(this.accessor.transport, objectId)) as JsonValue
    } catch (err) {
      if (!(err instanceof NotionAPIError) || err.status !== 404) throw err
      console.debug(`notion events: ${objectId} is not readable: ${err.message}`)
      return null
    }
  }

  private async place(kind: string, objectId: string, fresh = false): Promise<string | null> {
    if (!fresh && this.places.has(objectId)) return this.places.get(objectId) ?? null
    let place: string | null = null
    if (kind === 'database') {
      const database = await this.read(getDatabase, objectId)
      if (database !== null && typeof database === 'object' && !Array.isArray(database)) {
        place = `databases/${databaseSegmentName(database)}`
      }
    } else if (kind === 'data_source') {
      const source = await this.read(getDataSource, objectId)
      const owner = textField(field(source, 'parent'), 'database_id')
      const above = owner !== null && owner !== '' ? await this.place('database', owner) : null
      if (
        source !== null &&
        typeof source === 'object' &&
        !Array.isArray(source) &&
        above !== null
      ) {
        place = `${above}/${dataSourceSegmentName(source)}`
      }
    } else {
      const page = await this.read(getPage, objectId)
      const above = await this.pageParent(page)
      if (page !== null && typeof page === 'object' && !Array.isArray(page) && above !== null) {
        place = `${above}/${pageSegmentName(page)}`
      }
    }
    this.places.set(objectId, place)
    return place
  }

  private async pageParent(page: JsonValue): Promise<string | null> {
    const from = field(page, 'parent')
    const kind = textField(from, 'type')
    if (kind === 'workspace') return 'pages'
    if (kind === 'page_id') {
      const above = textField(from, 'page_id')
      return above !== null && above !== '' ? this.place('page', above) : null
    }
    if (kind === 'data_source_id') {
      const above = textField(from, 'data_source_id')
      return above !== null && above !== '' ? this.place('data_source', above) : null
    }
    return null
  }

  private forget(place: string): void {
    for (const [objectId, known] of [...this.places]) {
      if (known !== null && underPath(known, place)) {
        this.places.delete(objectId)
      }
    }
  }

  private companions(
    root: PathSpec,
    kind: string,
    places: readonly (string | null)[],
  ): FileEvent[] {
    const found: string[] = []
    for (const place of places) {
      if (place === null) continue
      const beside =
        kind === 'page'
          ? rowsOf(place)
          : kind === 'data_source'
            ? `${parent(place)}/database.json`
            : null
      if (beside !== null && !found.includes(beside)) found.push(beside)
    }
    return found.map((path) => eventAt(root, path, FileChangeKind.UPDATE))
  }

  async toEvents(
    root: PathSpec,
    eventType: string,
    payload: JsonValue,
  ): Promise<readonly FileEvent[]> {
    const dot = eventType.indexOf('.')
    const kind = dot < 0 ? eventType : eventType.slice(0, dot)
    const change = dot < 0 ? '' : eventType.slice(dot + 1)
    const objectId = textField(field(payload, 'entity'), 'id')
    if (objectId === null || !(kind === 'page' || kind === 'database' || kind === 'data_source')) {
      return []
    }
    const own = OWN_FILES[kind] ?? []
    if (GONE.has(eventType)) {
      const place = await this.place(kind, objectId)
      if (place === null) return []
      this.forget(place)
      return [eventAt(root, place, FileChangeKind.DELETE), ...this.companions(root, kind, [place])]
    }
    if (MADE.has(eventType)) {
      const place = await this.place(kind, objectId, true)
      if (place === null) return []
      return [
        ...own.map((name) => eventAt(root, `${place}/${name}`, FileChangeKind.CREATE)),
        ...this.companions(root, kind, [place]),
      ]
    }
    if (PLACED.has(eventType)) {
      const was = this.places.get(objectId) ?? null
      const now = await this.place(kind, objectId, true)
      const events: FileEvent[] = []
      if (was === null && change === 'moved' && kind !== 'database') {
        events.push(eventAt(root, '', FileChangeKind.UNKNOWN))
      }
      if (was !== null && was !== now) {
        this.forget(was)
        events.push(eventAt(root, was, FileChangeKind.UNKNOWN))
        if (now !== null) this.places.set(objectId, now)
      }
      if (now === null) return [...events, ...this.companions(root, kind, [was])]
      const properties = field(field(payload, 'data'), 'updated_properties')
      const retitled = Array.isArray(properties) && properties.includes('title')
      if (
        (was !== null && was !== now) ||
        change === 'schema_updated' ||
        (change === 'moved' && kind !== 'database')
      ) {
        events.push(eventAt(root, now, FileChangeKind.UNKNOWN))
      } else if (was === null && retitled) {
        events.push(eventAt(root, parent(now), FileChangeKind.UNKNOWN))
      } else {
        events.push(eventAt(root, `${now}/${own[0] ?? ''}`, FileChangeKind.UPDATE))
      }
      return [...events, ...this.companions(root, kind, [was, now])]
    }
    if (change !== 'content_updated') return []
    const place = await this.place(kind, objectId)
    if (place === null) return []
    if (kind === 'page') {
      return [
        eventAt(root, `${place}/page.json`, FileChangeKind.UPDATE),
        ...this.companions(root, kind, [place]),
      ]
    }
    if (kind === 'data_source') return [eventAt(root, `${place}/rows.jsonl`, FileChangeKind.UPDATE)]
    return [eventAt(root, place, FileChangeKind.UNKNOWN)]
  }
}
