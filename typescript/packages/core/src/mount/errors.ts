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
import type { FsCondition } from '../errors/types.ts'

// Genuine last resort, for an error whose only signal is its message (a
// third-party client's untyped failure). "read-only" and "no mount" are not
// here: those arrive typed and `classify` names them. Mirrors python's
// `_MESSAGE_CODES`.
const MESSAGE_CODES: [string[], FsCondition][] = [
  [['not empty', 'enotempty'], 'ENOTEMPTY'],
  [['not a directory', 'enotdir'], 'ENOTDIR'],
  [['is a directory', 'eisdir'], 'EISDIR'],
  [['permission', 'eacces'], 'EACCES'],
  [['file exists', 'eexist'], 'EEXIST'],
  [['not found', 'no such', 'enoent'], 'ENOENT'],
]

/** The condition an error's message alone names, or null: a last resort after `classify`. */
export function messageCondition(err: unknown): FsCondition | null {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return MESSAGE_CODES.find(([needles]) => needles.some((n) => msg.includes(n)))?.[1] ?? null
}

/**
 * An SFTP request answered with a status the core cannot express as an
 * errno: an operation mirage does not offer, or a workspace that is not
 * there. asyncssh raises its own SFTPError classes for these on the
 * Python side.
 */
export class SFTPStatusError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'SFTPStatusError'
    this.status = status
  }
}
