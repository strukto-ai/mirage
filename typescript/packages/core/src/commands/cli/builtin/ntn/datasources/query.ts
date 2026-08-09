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

import { FlagView } from '../../../../spec/types.ts'
import { NotionAPIError, type NotionTransport } from '../../../../../core/notion/_client.ts'
import {
  getDataSource,
  getDatabase,
  queryDataSourcePage,
} from '../../../../../core/notion/pages.ts'
import { IOResult } from '../../../../../io/types.ts'
import { PathSpec } from '../../../../../types.ts'
import type { CommandFnResult } from '../../../../config.ts'
import type { CLIInvocation } from '../../../types.ts'
import {
  firstText,
  notionTransport,
  parseJsonText,
  prettyJson,
  propertyCell,
  usageError,
} from '../util.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const DEFAULT_LIMIT = 25
const DIRECTIONS: Record<string, string> = {
  asc: 'ascending',
  ascending: 'ascending',
  desc: 'descending',
  descending: 'descending',
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function strOf(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

// A data source operand may be an id or a full Notion URL.
function dataSourceRef(operand: string): string {
  const tail = operand.split('/').pop() ?? operand
  return tail.split('?')[0] ?? tail
}

function parseSort(spec: string): Record<string, unknown> {
  const at = spec.lastIndexOf(' ')
  if (at > 0) {
    const tail = spec.slice(at + 1).toLowerCase()
    const direction = DIRECTIONS[tail]
    if (direction !== undefined) return { property: spec.slice(0, at), direction }
  }
  return { property: spec, direction: 'ascending' }
}

// A database id is accepted in the same slot as a data source id, so a miss on
// the data source endpoint is not an error until the database endpoint misses
// too.
async function resolveSource(
  transport: NotionTransport,
  ref: string,
): Promise<Record<string, unknown>> {
  try {
    return await getDataSource(transport, ref)
  } catch (err) {
    if (!(err instanceof NotionAPIError) || err.status !== 404) throw err
  }
  const database = await getDatabase(transport, ref)
  const stubs: unknown[] = Array.isArray(database.data_sources) ? database.data_sources : []
  const head = stubs[0]
  if (head === undefined) throw new Error(`database ${ref} has no data sources`)
  return getDataSource(transport, strOf(asObject(head), 'id'))
}

// The query filter comes from --filter or --filter-file, and the file is read
// through the op dispatcher the way himalaya reads --attach: an account CLI may
// read a workspace file the user named on the line, it just must not treat a
// mount as a second view of its own account's data.
async function filterBody(
  fl: FlagView,
  ops: CLIInvocation['ops'],
): Promise<Record<string, unknown> | null> {
  const inline = fl.asStr('filter')
  if (inline !== undefined && inline !== '') return parseJsonText(inline, '--filter')
  const source = fl.asStr('filter_file')
  if (source === undefined || source === '') return null
  const dispatch = ops?.dispatch
  if (dispatch === undefined) throw new Error('--filter-file needs a workspace to read files from')
  const [data] = await dispatch('read', PathSpec.fromStrPath(source))
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike)
  return parseJsonText(DEC.decode(bytes), '--filter-file')
}

export async function query(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const body: Record<string, unknown> = {}
  let ref: string
  try {
    ref = dataSourceRef(firstText(inv.texts, 'data source id'))
    body.page_size = fl.asInt('limit') ?? DEFAULT_LIMIT
    const cursor = fl.asStr('start_cursor')
    if (cursor !== undefined && cursor !== '') body.start_cursor = cursor
    const sorts = fl.asList('sort').map(parseSort)
    if (sorts.length > 0) body.sorts = sorts
    const chosen = await filterBody(fl, inv.ops)
    if (chosen !== null) body.filter = chosen
  } catch (err) {
    return usageError(err)
  }

  const transport = notionTransport(inv.config, inv.flags)
  const dataSource = await resolveSource(transport, ref)
  const result = await queryDataSourcePage(transport, strOf(dataSource, 'id'), body)
  if (fl.asBool('json')) return [prettyJson(result), new IOResult()]

  // Columns are the schema's property names in alphabetical order, which is
  // what the upstream CLI prints whatever order the API reports the schema in.
  const columns = Object.keys(asObject(dataSource.properties)).sort()
  const rows = Array.isArray(result.results) ? result.results : []
  let out = ''
  for (const row of rows) {
    const record = asObject(row)
    const props = asObject(record.properties)
    const cells = columns.map((name) => propertyCell(props[name]))
    out += `${[strOf(record, 'id'), ...cells].join('\t')}\n`
  }
  const stdout = ENC.encode(out)
  const cursor = result.next_cursor
  if (result.has_more === true && typeof cursor === 'string' && cursor !== '') {
    const notice = `\nMore results available. Use --start-cursor ${cursor} to continue.\n`
    return [stdout, new IOResult({ stderr: ENC.encode(notice) })]
  }
  return [stdout, new IOResult()]
}
