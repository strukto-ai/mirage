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

import type { CommandFnResult, Context } from '../../../config.ts'
import type { PathSpec } from '../../../../types.ts'
import { FlagView } from '../../../spec/index.ts'
import { IOResult } from '../../../../io/types.ts'
import type { EmailAccessor } from '../../../../accessor/email.ts'
import { listFolderEntries, mailboxCounts } from '../../../../core/email/client.ts'
import { rendered } from './printer.ts'
import { cell, renderTable, row, type Cell } from './table.ts'

const NOSELECT = '\\noselect'

function countCell(value: number | null): Cell {
  return cell(value === null ? '' : String(value))
}

export async function mailboxList(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const withCounts = fl.asBool('counts')
  const entries = []
  for (const entry of await listFolderEntries(accessor)) {
    if (entry.attributes.some((attribute) => attribute.toLowerCase() === NOSELECT)) continue
    const [total, unread] = withCounts ? await mailboxCounts(accessor, entry.name) : [null, null]
    const inbox = entry.name.toUpperCase() === 'INBOX'
    const label = inbox ? 'Inbox' : entry.name
    const role = inbox
      ? 'inbox'
      : entry.name === accessor.config.trashFolder
        ? 'trash'
        : entry.name === accessor.config.sentFolder
          ? 'sent'
          : null
    entries.push({ id: label, name: label, role, total, unread })
  }
  const titles = ['ID', 'NAME', 'ROLE', ...(withCounts ? ['TOTAL', 'UNREAD'] : [])]
  const rows = entries.map((entry) => {
    const cells = [cell(entry.id), cell(entry.name), cell(entry.role ?? '')]
    if (withCounts) cells.push(countCell(entry.total), countCell(entry.unread))
    return row(cells)
  })
  const table = renderTable(
    row(
      titles.map((title) => cell(title)),
      null,
    ),
    rows,
    fl.asInt('max_width') ?? null,
  )
  return [rendered(fl, { mailboxes: entries }, `\n${table}\n`), new IOResult()]
}
