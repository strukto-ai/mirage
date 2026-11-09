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

import { cell, formatSize, renderTable, row, type Cell } from './table.ts'

const UNSEEN_CHAR = '*'
const REPLIED_CHAR = 'R'
const FLAGGED_CHAR = '!'
const ATTACHMENT_CHAR = '@'

export interface EnvelopeAddress {
  name: string | null
  email: string
}

export interface EnvelopeDocument {
  id: string
  flags: { raw: string; iana: string | null }[]
  subject: string
  from: EnvelopeAddress[]
  to: EnvelopeAddress[]
  date: string | null
  size: number
  'has-attachment': boolean | null
}

function flagsCell(flags: EnvelopeDocument['flags']): string {
  const names = new Set(flags.map((flag) => flag.iana))
  return (
    (names.has('seen') ? ' ' : UNSEEN_CHAR) +
    (names.has('answered') ? REPLIED_CHAR : ' ') +
    (names.has('flagged') ? FLAGGED_CHAR : ' ')
  )
}

function dateCell(value: string | null): string {
  if (value === null || value === '') return ''
  const head = `${value.slice(0, 10)} ${value.slice(11, 16)}`
  const zone = value.endsWith('Z') ? '+00:00' : value.slice(19)
  return `${head}${zone}`
}

function addressCell(entries: readonly EnvelopeAddress[]): string {
  return entries
    .map((entry) => (entry.name !== null && entry.name !== '' ? entry.name : entry.email))
    .join(', ')
}

/** The listing a human reads. */
export function envelopesTable(
  documents: readonly EnvelopeDocument[],
  withAttachment: boolean,
  recipient: boolean,
  maxWidth: number | null,
): string {
  const titles: Cell[] = [cell('ID'), cell('FLAGS')]
  if (withAttachment) titles.push(cell('ATT'))
  titles.push(cell('SUBJECT'), cell(recipient ? 'TO' : 'FROM'), cell('DATE'), cell('SIZE', true))
  const rows = documents.map((document) => {
    const cells: Cell[] = [cell(document.id), cell(flagsCell(document.flags))]
    if (withAttachment) {
      const attached = document['has-attachment']
      cells.push(cell(attached === true ? ATTACHMENT_CHAR : attached === false ? '' : '?'))
    }
    cells.push(
      cell(document.subject),
      cell(addressCell(recipient ? document.to : document.from)),
      cell(dateCell(document.date)),
      cell(formatSize(document.size), true),
    )
    return row(cells)
  })
  const table = renderTable(row(titles), rows, maxWidth, new Set([0]))
  return `\n${table}\n`
}
