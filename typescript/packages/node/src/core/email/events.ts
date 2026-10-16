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

import {
  FileChangeKind,
  type FileEvent,
  type JsonValue,
  type PathSpec,
} from '@struktoai/mirage-core/types'
import { eventAt, textField } from '@struktoai/mirage-core/events/index'

// The untagged IDLE responses that change what a mailbox holds or shows.
const MAILBOX_CHANGES: ReadonlySet<string> = new Set(['EXISTS', 'EXPUNGE', 'FETCH', 'VANISHED'])

/**
 * Map one IMAP IDLE response onto mount paths.
 *
 * The consumer holds the IDLE connection on a mailbox and passes each untagged
 * response's name (`EXISTS`, `EXPUNGE`, `FETCH` or `VANISHED`) with
 * `{"mailbox": <name>}`, the mailbox it selected. Nothing here runs a loop.
 *
 * A response names a message by its sequence number in the mailbox, never by
 * UID, and says nothing of its date, while a message file is
 * `<folder>/<day>/<subject>__<uid>.email.json`. `EXISTS` (a message arrived),
 * `EXPUNGE` and `VANISHED` (one left) and `FETCH` (its flags, which the file
 * renders, changed) therefore name only the folder, which is UNKNOWN. The
 * folder is the mailbox's name as the server lists it, which is how `readdir`
 * names it. `RECENT` comes with `EXISTS` and maps to nothing.
 *
 * Mirrors Python `EmailEventHook` (`core/email/events.py`).
 */
export class EmailEventHook {
  toEvents(root: PathSpec, eventType: string, payload: JsonValue): Promise<readonly FileEvent[]> {
    const mailbox = textField(payload, 'mailbox')
    if (!MAILBOX_CHANGES.has(eventType.toUpperCase()) || mailbox === null || mailbox === '') {
      return Promise.resolve([])
    }
    return Promise.resolve([eventAt(root, mailbox, FileChangeKind.UNKNOWN)])
  }
}
