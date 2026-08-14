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

import { EmailAccessor } from '../../../../accessor/email.ts'
import { listFolderEntries } from '../../../../core/email/_client.ts'
import type { ParsedRfc822 } from '../../../../core/email/_parse.ts'
import type { EmailConfig } from '../../../../core/email/config.ts'
import { sendRaw } from './smtp.ts'

const SENT_ATTRIBUTE = '\\sent'
const DEFAULT_SENT_FOLDER = 'Sent'
const SEEN_FLAG = '\\Seen'

export interface Delivery {
  parsed: ParsedRfc822
  /** A line for stderr, empty when there is nothing to report. */
  warning: string
}

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
  const entries = await listFolderEntries(accessor)
  const tagged = entries.find((entry) => entry.specialUse?.toLowerCase() === SENT_ATTRIBUTE)
  return tagged?.name ?? DEFAULT_SENT_FOLDER
}

/**
 * APPENDs a message to a mailbox, seen, and answers with the mailbox it
 * landed in. `named` is the mailbox --save gave; without one the
 * account's own sent mailbox is resolved.
 *
 * Unlike python's, this path quotes nothing: imapflow builds the
 * command from typed attributes, so a mailbox holding a space arrives
 * as one argument on its own.
 */
export async function saveSentCopy(
  config: EmailConfig,
  raw: Uint8Array,
  named: string | null = null,
): Promise<string> {
  const accessor = new EmailAccessor(config)
  try {
    const folder = named ?? (await resolveSentFolder(accessor, config.sentFolder))
    const imap = await accessor.getImap()
    const result = await imap.append(folder, Buffer.from(raw), [SEEN_FLAG])
    if (result === false) throw new Error(`${folder}: the server refused the message`)
    return folder
  } finally {
    await accessor.close()
  }
}

/**
 * Sends a message over SMTP, then files the sender's own copy.
 *
 * Two conversations with two servers: SMTP hands the message to the
 * recipient's side and keeps no record, so the copy in the sender's
 * Sent mailbox is a separate IMAP APPEND that every mail client makes
 * on its own. Upstream v2 spells that APPEND as `--save <MAILBOX>` and
 * does nothing without it; mirage keeps the account-level `saveCopy` on
 * top, defaulted on, so an agent that never learned the flag still
 * leaves the record a human sender would.
 *
 * The other deliberate divergence is the failure arm. Upstream
 * propagates, which fails the command after the mail has already left;
 * here the APPEND failure is reported on stderr and the verb still
 * succeeds, because a non-zero exit invites a retry that sends the
 * message twice. A `--save` that sends nothing does not go through here
 * at all, precisely because nothing happened yet and failing is safe.
 */
export async function deliver(
  config: EmailConfig,
  raw: Uint8Array,
  save: string | null = null,
): Promise<Delivery> {
  const parsed = await sendRaw(config, raw)
  if (save === null && !config.saveCopy) return { parsed, warning: '' }
  try {
    await saveSentCopy(config, raw, save)
  } catch (error) {
    // Every failure mode is caught on purpose: the message is already
    // delivered by this point, so no fault of the copy may turn into a
    // failed send. Nothing is swallowed, the reason is printed.
    const reason = error instanceof Error ? error.message : String(error)
    return { parsed, warning: `himalaya: sent copy not saved: ${reason}\n` }
  }
  return { parsed, warning: '' }
}
