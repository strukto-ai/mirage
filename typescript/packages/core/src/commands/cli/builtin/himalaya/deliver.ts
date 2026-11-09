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

import type { EmailAccessor } from '../../../../accessor/email.ts'
import { listFolderEntries } from '../../../../core/email/client.ts'
import { ChainedError } from './printer.ts'
import { sendRaw } from './smtp.ts'

const SENT_ATTRIBUTE = '\\sent'
const DEFAULT_SENT_FOLDER = 'Sent'
const SEEN_FLAG = '\\Seen'

/**
 * Names the mailbox a sent copy belongs in.
 *
 * IMAP never standardized that name: it is `Sent` on most servers,
 * `Sent Items` on Exchange and `[Gmail]/Sent Mail` on Gmail. A server
 * that implements RFC 6154 tags the right one \Sent in its LIST reply,
 * so asking beats guessing; upstream himalaya has no probe and falls
 * back on its folder.alias.sent, which is the configured name here and
 * wins so a server whose tag is wrong stays correctable.
 */
export async function resolveSentFolder(
  accessor: EmailAccessor,
  configured: string | null,
): Promise<string> {
  if (configured !== null && configured !== '') return configured
  return taggedFolder(accessor, SENT_ATTRIBUTE, DEFAULT_SENT_FOLDER)
}

/** The mailbox the server tags with an RFC 6154 attribute, lowercase. */
export async function taggedFolder(
  accessor: EmailAccessor,
  attribute: string,
  fallback: string,
): Promise<string> {
  const entries = await listFolderEntries(accessor)
  const tagged = entries.find((entry) =>
    entry.attributes.some((name) => name.toLowerCase() === attribute),
  )
  return tagged?.name ?? fallback
}

/**
 * APPENDs a message and reports the UID the server assigned, null when
 * it does not report one. imapflow builds the command from typed
 * attributes, so a mailbox holding a space arrives as one argument.
 */
export async function appendMessage(
  accessor: EmailAccessor,
  raw: Uint8Array,
  folder: string,
  flags: readonly string[],
): Promise<string | null> {
  const imap = await accessor.getImap()
  const result = await imap.append(folder, Buffer.from(raw), [...flags])
  if (result === false) throw new Error(`${folder}: the server refused the message`)
  return result.uid === undefined ? null : String(result.uid)
}

/** APPENDs a message to a mailbox, seen, the way upstream saves one. */
export async function saveSentCopy(
  accessor: EmailAccessor,
  raw: Uint8Array,
  named: string | null = null,
): Promise<string> {
  const folder = named ?? (await resolveSentFolder(accessor, accessor.config.sentFolder))
  await appendMessage(accessor, raw, folder, [SEEN_FLAG])
  return folder
}

/**
 * Sends a message over SMTP, then files the sender's own copy.
 *
 * Two conversations with two servers: SMTP hands the message to the
 * recipient's side and keeps no record, so the copy in the sender's
 * Sent mailbox is a separate IMAP APPEND. `--save <MAILBOX>` names it,
 * the account's `saveCopy` asks for one without the flag, and
 * `--no-save` skips it. The send goes first, so a failed send leaves no
 * copy behind; a copy that then fails is reported as a failure of the
 * command, the way upstream reports it, saying the message left.
 */
export async function deliver(
  accessor: EmailAccessor,
  raw: Uint8Array,
  save: string | null = null,
  noSave = false,
): Promise<boolean> {
  await sendRaw(accessor.config, raw)
  if (noSave || (save === null && !accessor.config.saveCopy)) return false
  let folder = save ?? accessor.config.sentFolder ?? DEFAULT_SENT_FOLDER
  try {
    folder = save ?? (await resolveSentFolder(accessor, accessor.config.sentFolder))
    await appendMessage(accessor, raw, folder, [SEEN_FLAG])
  } catch (error) {
    throw new ChainedError(`Message sent, but saving a copy to ${folder} failed`, [
      error instanceof Error ? error.message : String(error),
    ])
  }
  return true
}
