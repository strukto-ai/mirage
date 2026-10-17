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

import type { AirtableAccessor } from '../../../../accessor/airtable.ts'
import {
  createComment,
  createRecords,
  deleteRecords,
  listTables,
  updateRecords,
} from '../../../../core/airtable/client.ts'
import { COMPUTED_TYPES, LINE_KEYS } from '../../../../core/airtable/constants.ts'
import {
  asRow,
  asRows,
  deletionsJsonl,
  isRow,
  normalizeComment,
  recordsJsonl,
  toJsonBytes,
  type Row,
} from '../../../../core/airtable/normalize.ts'
import { IOResult } from '../../../../io/types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { AirtableConfig } from '../../../../core/airtable/config.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { UsageError } from '../../../errors.ts'
import type { FlagView } from '../../../spec/flag_view.ts'
import {
  findTable,
  jsonObject,
  noOperands,
  oneOperand,
  optionalOperand,
  run,
  scopedBase,
  stdinText,
} from './util.ts'

const ENC = new TextEncoder()

/**
 * Stdin's JSONL, one normalized record per line, validated whole. A line is
 * the shape records.jsonl holds, so a mount read piped through jq
 * round-trips. Every line is checked before anything is sent: a bad line 15
 * must not leave ten records already written. A blank line is skipped but
 * still counted, so a refusal names the line an editor shows.
 */
function recordLines(text: string, need: { id: boolean; fields: boolean }): Row[] {
  const rows: Row[] = []
  text.split('\n').forEach((line, index) => {
    if (/^[ \t\r]*$/.test(line)) return
    const where = `stdin line ${String(index + 1)}`
    let row: unknown
    try {
      row = JSON.parse(line) as unknown
    } catch {
      throw new UsageError(`${where}: not valid JSON`)
    }
    if (!isRow(row)) throw new UsageError(`${where}: not a JSON object`)
    const unknown = Object.keys(row)
      .filter((key) => !LINE_KEYS.has(key))
      .sort(compareCodePoints)[0]
    if (unknown !== undefined) {
      throw new UsageError(`${where}: unknown key ${JSON.stringify(unknown)}`)
    }
    if ('fields' in row && !isRow(row.fields)) {
      throw new UsageError(`${where}: "fields" must be an object`)
    }
    if (need.id && !('record_id' in row)) {
      throw new UsageError(`${where}: "record_id" is required`)
    }
    if (need.id && typeof row.record_id !== 'string') {
      throw new UsageError(`${where}: "record_id" must be a string`)
    }
    if (need.fields && !('fields' in row)) {
      throw new UsageError(`${where}: "fields" is required`)
    }
    rows.push(row)
  })
  return rows
}

/** The cells with every computed field of the table taken out. */
async function writable(
  accessor: AirtableAccessor,
  baseId: string,
  table: string,
  cells: Row[],
): Promise<Row[]> {
  const found = findTable(await listTables(accessor, baseId), table)
  const fields = asRows(asRow(found).fields)
  const computed = new Set(
    fields.filter((f) => COMPUTED_TYPES.has(String(f.type))).map((f) => f.name),
  )
  return cells.map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => !computed.has(k))))
}

/**
 * Everything the batches wrote, and the failure that stopped them. Batches
 * land one request at a time, so a failure part way leaves the earlier ones
 * written. They are printed anyway, with the error on stderr and exit 1, so
 * the line shows what reached the base. A failure before anything landed
 * throws, for the executor to render as `<prog>: <error>`; a partial one
 * carries no prefix, since only the executor knows the head word the CLI was
 * installed under, and the error names its call.
 */
async function landed(
  batches: AsyncIterable<Row[]>,
  render: (rows: Row[]) => Uint8Array,
): Promise<CommandFnResult> {
  const done: Row[] = []
  try {
    for await (const batch of batches) done.push(...batch)
  } catch (err) {
    if (done.length === 0) throw err
    const message = err instanceof Error ? err.message : String(err)
    return [render(done), new IOResult({ exitCode: 1, stderr: ENC.encode(`${message}\n`) })]
  }
  return [render(done), new IOResult()]
}

async function recordCreateBody(
  config: AirtableConfig,
  texts: string[],
  ctx: Context,
  accessor: AirtableAccessor,
  fl: FlagView,
): Promise<CommandFnResult> {
  noOperands(texts)
  const fields = fl.asStr('fields')
  const table = fl.asStr('table') ?? ''
  let cells: Row[]
  let piped = false
  if (fields !== undefined) {
    cells = [jsonObject('--fields', fields)]
  } else if (ctx.stdin !== null) {
    const rows = recordLines(await stdinText(ctx.stdin), { id: false, fields: true })
    cells = rows.map((row) => row.fields as Row)
    piped = rows.length > 0
  } else {
    throw new UsageError('--fields or records on stdin are required')
  }
  const baseId = scopedBase(config, fl.asStr('base') ?? '')
  if (piped) cells = await writable(accessor, baseId, table, cells)
  const batches = createRecords(accessor, baseId, table, cells, {
    typecast: fl.asBool('typecast'),
  })
  return landed(batches, recordsJsonl)
}

async function recordUpdateBody(
  config: AirtableConfig,
  texts: string[],
  ctx: Context,
  accessor: AirtableAccessor,
  fl: FlagView,
): Promise<CommandFnResult> {
  const recordId = optionalOperand(texts)
  const fields = fl.asStr('fields')
  const table = fl.asStr('table') ?? ''
  if (recordId !== null && fields === undefined) {
    throw new UsageError('--fields is required with RECORD')
  }
  if (recordId === null && fields !== undefined) {
    throw new UsageError('RECORD is required with --fields')
  }
  let ids: string[]
  let cells: Row[]
  let piped = false
  if (recordId !== null && fields !== undefined) {
    ids = [recordId]
    cells = [jsonObject('--fields', fields)]
  } else if (ctx.stdin !== null) {
    const rows = recordLines(await stdinText(ctx.stdin), { id: true, fields: true })
    ids = rows.map((row) => String(row.record_id))
    cells = rows.map((row) => row.fields as Row)
    piped = rows.length > 0
  } else {
    throw new UsageError('RECORD --fields or records on stdin are required')
  }
  const baseId = scopedBase(config, fl.asStr('base') ?? '')
  if (piped) cells = await writable(accessor, baseId, table, cells)
  const updates = ids.map((id, i): [string, Row] => [id, cells[i] ?? {}])
  const batches = updateRecords(accessor, baseId, table, updates, {
    typecast: fl.asBool('typecast'),
  })
  return landed(batches, recordsJsonl)
}

async function recordDeleteBody(
  config: AirtableConfig,
  texts: string[],
  ctx: Context,
  accessor: AirtableAccessor,
  fl: FlagView,
): Promise<CommandFnResult> {
  let recordIds: string[]
  if (texts.length > 0) {
    recordIds = [...texts]
  } else if (ctx.stdin !== null) {
    const rows = recordLines(await stdinText(ctx.stdin), { id: true, fields: false })
    recordIds = rows.map((row) => String(row.record_id))
  } else {
    throw new UsageError('RECORD or records on stdin are required')
  }
  const baseId = scopedBase(config, fl.asStr('base') ?? '')
  const batches = deleteRecords(accessor, baseId, fl.asStr('table') ?? '', recordIds)
  return landed(batches, deletionsJsonl)
}

async function commentAddBody(
  config: AirtableConfig,
  texts: string[],
  ctx: Context,
  accessor: AirtableAccessor,
  fl: FlagView,
): Promise<CommandFnResult> {
  const recordId = oneOperand(texts, 'RECORD')
  let text = fl.asStr('text')
  if (text === undefined) {
    if (ctx.stdin === null) throw new UsageError('--text or text on stdin is required')
    const piped = await stdinText(ctx.stdin)
    text = piped.endsWith('\n') ? piped.slice(0, -1) : piped
  }
  if (text === '') throw new UsageError('the comment text is empty')
  const baseId = scopedBase(config, fl.asStr('base') ?? '')
  const comment = await createComment(accessor, baseId, fl.asStr('table') ?? '', recordId, text)
  return [toJsonBytes(normalizeComment(comment)), new IOResult()]
}

export const recordCreate = run(recordCreateBody)
export const recordUpdate = run(recordUpdateBody)
export const recordDelete = run(recordDeleteBody)
export const commentAdd = run(commentAddBody)
