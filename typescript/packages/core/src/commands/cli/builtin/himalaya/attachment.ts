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
import { PathSpec as PathSpecClass } from '../../../../types.ts'
import { FlagView } from '../../../spec/index.ts'
import { IOResult } from '../../../../io/types.ts'
import type { EmailAccessor } from '../../../../accessor/email.ts'
import {
  attributeOf,
  contentTypeOf,
  parseMime,
  partAt,
  type MimeBody,
  type MimeHeader,
  type MimeMessage,
} from '../../../../core/email/mime.ts'
import type { Files } from '../../../../workspace/files.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { ensureDir } from '../../operand.ts'
import { rendered } from './printer.ts'
import { cell, formatSize, renderTable, row } from './table.ts'
import { fetchSource } from './util.ts'

const MAX_NAME_TRIES = 1024
export const PARSE_FAILURE = 'Failed to parse RFC 5322 message'
const ENC = new TextEncoder()

export interface AttachmentRow {
  id: string
  filename: string | null
  mime: string | null
  payload: Uint8Array
  inline: boolean
}

/** The file name a part carries. */
export function partName(headers: MimeHeader[]): string | null {
  return (
    attributeOf(contentTypeOf(headers, 'content_disposition'), 'filename') ??
    attributeOf(contentTypeOf(headers, 'content_type'), 'name')
  )
}

/** A part's MIME type as `type/subtype`. */
export function partMime(headers: MimeHeader[]): string | null {
  const content = contentTypeOf(headers, 'content_type')
  if (content === null) return null
  return content.c_subtype !== null ? `${content.c_type}/${content.c_subtype}` : content.c_type
}

/** A part's decoded contents. */
export function partPayload(body: MimeBody): Uint8Array {
  if ('Text' in body) return ENC.encode(body.Text)
  if ('Html' in body) return ENC.encode(body.Html)
  if ('Binary' in body) return Uint8Array.from(body.Binary)
  if ('InlineBinary' in body) return Uint8Array.from(body.InlineBinary)
  return 'Message' in body ? body.Message.raw : new Uint8Array(0)
}

/** Every attachment of a parsed message, in order. */
export function attachmentRows(message: MimeMessage): AttachmentRow[] {
  return message.attachments.map((partId) => {
    const part = partAt(message, partId)
    const disposition = contentTypeOf(part.headers, 'content_disposition')
    return {
      id: String(partId + 1),
      filename: partName(part.headers),
      mime: partMime(part.headers),
      payload: partPayload(part.body),
      inline: disposition !== null && disposition.c_type.toLowerCase() === 'inline',
    }
  })
}

async function rowsOf(
  accessor: EmailAccessor,
  mailbox: string,
  uid: string,
): Promise<AttachmentRow[]> {
  const raw = await fetchSource(accessor, mailbox, uid)
  const message = parseMime(raw)
  if (message === null) throw new Error(PARSE_FAILURE)
  return attachmentRows(message)
}

function document(entry: AttachmentRow, path: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: entry.id,
    filename: entry.filename,
    mime: entry.mime,
    size: entry.payload.length,
    inline: entry.inline,
  }
  if (path !== null) out.path = path
  return out
}

function table(
  rows: readonly AttachmentRow[],
  paths: readonly string[] | null,
  withInline: boolean,
): string {
  const titles = ['ID', 'FILENAME', 'TYPE', 'SIZE']
  if (withInline) titles.push('INLINE')
  if (paths !== null) titles.push('PATH')
  const body = rows.map((entry, index) => {
    const cells = [
      cell(entry.id),
      cell(entry.filename ?? ''),
      cell(entry.mime ?? ''),
      cell(formatSize(entry.payload.length)),
    ]
    if (withInline) cells.push(cell(entry.inline ? 'yes' : 'no'))
    if (paths !== null) cells.push(cell(paths[index] ?? ''))
    return row(cells)
  })
  return `\n${renderTable(
    row(
      titles.map((title) => cell(title)),
      null,
    ),
    body,
  )}\n`
}

/** A file name a hostile header cannot climb out of the directory with. */
function safeName(name: string): string {
  const cleaned = Array.from(name.trim())
    .map((char) => (char === '/' || char === '\\' || char === '\0' ? '_' : char))
    .join('')
    .replace(/^\.+/, '')
    .trim()
  return cleaned === '' ? 'attachment' : cleaned
}

/** A path in the directory that does not exist yet. */
async function uniquePath(vfs: Files, directory: PathSpec, name: string): Promise<PathSpec> {
  let candidate = directory.join(name)
  if (!(await vfs.exists(candidate))) return candidate
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  for (let n = 1; n < MAX_NAME_TRIES; n += 1) {
    candidate = directory.join(`${stem} (${String(n)})${extension}`)
    if (!(await vfs.exists(candidate))) return candidate
  }
  return directory.join(name)
}

export async function attachmentList(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const withInline = fl.asBool('inline')
  const rows = (await rowsOf(accessor, fl.asStr('mailbox', 'INBOX'), texts[0] ?? '')).filter(
    (entry) => withInline || !entry.inline,
  )
  const out = rendered(
    fl,
    { attachments: rows.map((entry) => document(entry, null)) },
    table(rows, null, withInline),
  )
  return [out, new IOResult()]
}

export async function attachmentDownload(
  accessor: EmailAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const uid = texts[0] ?? ''
  if (ctx.vfs === undefined) throw new Error('attachment download needs a workspace')
  const rows = await rowsOf(accessor, fl.asStr('mailbox', 'INBOX'), uid)
  const directory = fl.asPath('dir') ?? PathSpecClass.fromStrPath('.', ctx.cwd.virtual)
  await ensureDir(ctx.vfs, directory)
  const remaining = new Set(texts.slice(1))
  const written: AttachmentRow[] = []
  const writtenPaths: string[] = []
  for (const entry of rows) {
    if (texts.length > 1 && !remaining.has(entry.id)) continue
    remaining.delete(entry.id)
    const name = safeName(entry.filename ?? `attachment-${entry.id}`)
    const path = await uniquePath(ctx.vfs, directory, name)
    await ctx.vfs.write(path, entry.payload)
    written.push(entry)
    writtenPaths.push(path.virtual)
  }
  if (remaining.size > 0) {
    throw new Error(
      `No attachment with id ${[...remaining].sort(compareCodePoints).join(', ')} on message \`${uid}\``,
    )
  }
  const out = rendered(
    fl,
    { attachments: written.map((entry, index) => document(entry, writtenPaths[index] ?? '')) },
    table(
      written,
      writtenPaths,
      written.some((entry) => entry.inline),
    ),
  )
  return [out, new IOResult()]
}
