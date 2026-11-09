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

import type { CommandFnResult } from '../../../config.ts'
import type { FlagView } from '../../../spec/index.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import { mimeTypeFor } from '../../../../utils/filetype.ts'
import { rstripSlash } from '../../../../utils/slash.ts'
import type { Files } from '../../../../workspace/files.ts'
import type { EmailAccessor } from '../../../../accessor/email.ts'
import { fetchRawMessage } from '../../../../core/email/client.ts'
import { headerValue, parseMime, type MimeValue } from '../../../../core/email/mime.ts'
import { readOperand } from '../../operand.ts'
import { build, readBody, type Attachment, type Source } from './builder.ts'
import { deliver, saveSentCopy } from './deliver.ts'
import { notice, rendered } from './printer.ts'

const NO_ENTRY = 2
const NOT_A_DIRECTORY = 20
const NO_BODY = 'FETCH returned no body for the requested message'
const MISSING_UID = 'email: uid '
const PARSE_FAILURE = 'Failed to parse composed message'
const ADDRESS_SPECIALS = '()<>[]:;@\\,."'

interface MailAddress {
  name: string | null
  address: string | null
}

/** A message's raw bytes, refused when the id matches nothing. */
export async function fetchSource(
  accessor: EmailAccessor,
  mailbox: string,
  uid: string,
): Promise<Uint8Array> {
  let raw: Uint8Array
  try {
    raw = await fetchRawMessage(accessor, mailbox, uid)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(MISSING_UID)) throw new Error(NO_BODY)
    throw error
  }
  if (raw.length === 0) throw new Error(NO_BODY)
  return raw
}

async function readFile(
  vfs: Files | undefined,
  path: PathSpec,
  flag: string,
  label: string,
): Promise<Uint8Array> {
  try {
    return await readOperand(vfs, path, flag, label)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = message.includes('Not a directory') ? NOT_A_DIRECTORY : NO_ENTRY
    throw new Error(`${message} (os error ${String(code)})`)
  }
}

/**
 * Reads --attach files through the workspace dispatcher.
 *
 * An account CLI has no mount of its own; an attachment is an unrelated
 * workspace file, so it is read through the op dispatcher the executor
 * hands every CLI, the same entry point git reads repositories through. The
 * flag bag carries typed paths with their original directory walks.
 */
async function loadAttachments(
  vfs: Files | undefined,
  paths: readonly PathSpec[],
): Promise<Attachment[]> {
  if (paths.length === 0) return []
  const attachments: Attachment[] = []
  for (const path of paths) {
    const data = await readFile(vfs, path, '--attach', 'read attachment')
    const trimmed = rstripSlash(path.virtual)
    const filename = trimmed.slice(trimmed.lastIndexOf('/') + 1) || 'attachment'
    attachments.push({ filename, contentType: mimeTypeFor(filename), data })
  }
  return attachments
}

async function readNamed(
  vfs: Files | undefined,
  path: PathSpec | undefined,
  flag: string,
  label: string,
): Promise<string | null> {
  if (path === undefined) return null
  return new TextDecoder().decode(await readFile(vfs, path, flag, label))
}

function mailboxText(entry: MailAddress): string {
  const email = entry.address ?? ''
  const name = entry.name
  if (name === null || name === '') return email
  if ([...name].some((char) => ADDRESS_SPECIALS.includes(char))) {
    return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" <${email}>`
  }
  return `${name} <${email}>`
}

function addressesOf(value: MimeValue): string[] {
  if (value === null || typeof value !== 'object' || !('Address' in value)) return []
  const address = (
    value as unknown as {
      Address: { List?: MailAddress[]; Group?: { addresses: MailAddress[] }[] }
    }
  ).Address
  if (address.List !== undefined) return address.List.map(mailboxText)
  return (address.Group ?? []).flatMap((group) => group.addresses.map(mailboxText))
}

/** The decoded fields of a composed message. */
export function templateDocument(raw: Uint8Array): Record<string, unknown> {
  const message = parseMime(raw)
  if (message === null) throw new Error(PARSE_FAILURE)
  const headers = message.parts[0]!.headers
  const document: Record<string, unknown> = {}
  const senders = addressesOf(headerValue(headers, 'from'))
  if (senders.length > 0) document.from = senders[0]
  document.to = addressesOf(headerValue(headers, 'to'))
  document.cc = addressesOf(headerValue(headers, 'cc'))
  document.bcc = addressesOf(headerValue(headers, 'bcc'))
  const subject = headerValue(headers, 'subject') as { Text?: string } | null
  if (subject !== null && typeof subject === 'object' && subject.Text !== undefined) {
    document.subject = subject.Text
  }
  const first = message.textBody[0]
  const body = first === undefined ? undefined : message.parts[first]!.body
  document.body = body !== undefined && 'Text' in body ? body.Text : ''
  return document
}

/** Route composed bytes: to stdout, a mailbox, SMTP, or both. */
export async function finishMessage(
  accessor: EmailAccessor,
  fl: FlagView,
  raw: Uint8Array,
  send: boolean,
): Promise<CommandFnResult> {
  const save = fl.asStr('save') ?? null
  const noSave = fl.asBool('no_save')
  if (!send && save === null) {
    if (fl.asBool('json')) return [rendered(fl, templateDocument(raw), ''), new IOResult()]
    return [raw as ByteSource, new IOResult()]
  }
  if (!send) {
    await saveSentCopy(accessor, raw, save)
    return [notice(fl, 'Message successfully saved'), new IOResult()]
  }
  const saved = await deliver(accessor, raw, save, noSave)
  const text = saved ? 'Message successfully saved and sent' : 'Message successfully sent'
  return [notice(fl, text), new IOResult()]
}

/**
 * Assembles a message, then sends it or writes its MIME to stdout.
 * Shared by compose, reply and forward: the three differ only in the
 * source message they derive headers from.
 */
export async function route(
  accessor: EmailAccessor,
  fl: FlagView,
  stdin: ByteSource | null,
  source: Source | null,
  vfs: Files | undefined,
): Promise<CommandFnResult> {
  const send = fl.asBool('send')
  const template = fl.asBool('json') && !send && (fl.asStr('save') ?? null) === null
  const bodyFile = await readNamed(vfs, fl.asPath('body_file'), '--body-file', 'read body file')
  let signature = fl.asStr('signature') ?? null
  if (!template && signature === null) {
    signature = await readNamed(
      vfs,
      fl.asPath('signature_file'),
      '--signature-file',
      'read signature file',
    )
  }
  const raw = build(
    {
      sender: fl.asStr('from', accessor.config.username),
      to: fl.asList('to'),
      cc: fl.asList('cc'),
      bcc: fl.asList('bcc'),
      subject: fl.asStr('subject') ?? null,
      body: await readBody(fl, stdin, bodyFile),
      signature: template ? null : signature,
      attachments: await loadAttachments(vfs, fl.asPaths('attach')),
    },
    source,
  )
  return finishMessage(accessor, fl, raw, send)
}
