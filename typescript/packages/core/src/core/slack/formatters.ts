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

import { fileIdName, makeIdName } from '../../utils/naming.ts'

/** Compute the VFS dirname for a channel, of the form `name__C123`. */
export function channelDirname(ch: { id: string; name?: string }): string {
  return makeIdName(ch.name ?? '', ch.id, true)
}

/** Compute the VFS dirname for a DM, of the form `username__D123`. */
export function dmDirname(
  dm: { id: string; user?: string },
  userMap: Record<string, string>,
): string {
  const uid = dm.user ?? ''
  const display = userMap[uid] ?? (uid === '' ? '' : uid)
  return makeIdName(display, dm.id, true)
}

/** Compute the VFS filename for a user, of the form `name__U123.json`. */
export function userFilename(u: { id: string; name?: string }): string {
  return makeIdName(u.name ?? '', u.id, true, '.json')
}

/**
 * Construct a stable VFS filename for a Slack file, of shape
 * `<stem>__<F-id>.<ext>`, named after `name` and else `title` (see
 * `fileIdName`).
 */
export function fileBlobName(file: { id?: string; name?: string; title?: string }): string {
  return fileIdName(file.id ?? '', file.name, file.title)
}
