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

/**
 * The nominal mailbox brand (Python's MailboxMixin inheritance), so core
 * can recognise node's IMAP client without importing it.
 */
export const MAILBOX: unique symbol = Symbol.for('mirage.mailbox')

/**
 * A client that reads a mailbox, over IMAP or the Gmail API (Python's
 * MailboxMixin). Mail written through any route (an IMAP append, an SMTP
 * send, a Gmail send) can land in any mailbox, so a mail writer's `reaches`
 * admits every client that carries the brand.
 */
export interface Mailbox {
  readonly [MAILBOX]: true
}

/** Whether `peer` carries the mailbox brand. */
export function isMailbox(peer: object): peer is Mailbox {
  return (peer as Partial<Mailbox>)[MAILBOX] === true
}
