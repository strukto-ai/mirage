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

import { ContentType } from '../../types.ts'
import { NAME_MAX_BYTES, byteLength, sanitizeLabel } from '../../utils/sanitize.ts'
import type { Codec } from '../hierarchy/codec.ts'
import { Slot, Scope } from '../hierarchy/scope.ts'
import { CORPUS } from './constants.ts'

const TITLE_MAX_CHARS = 100
const DATE_LEN = 10

const sanitizeTitle = (title: string, maxBytes: number): string =>
  sanitizeLabel(title, { fallback: 'Untitled', maxLen: TITLE_MAX_CHARS, maxBytes })

/**
 * The tree of a Google app mount: its corpora and their files. One
 * description per app: readdir, stat, read and unlink all classify through
 * it, so the file surface and the write surface cannot disagree about what a
 * path means. Sheets, Docs and Slides differ only in the codec of a file
 * name. Mirrors Python's `app_scopes`.
 */
export function appScopes(fileName: Codec): readonly Scope[] {
  return [
    new Scope({ kind: 'corpus', segments: [new Slot('corpus', CORPUS)], probed: false }),
    new Scope({
      kind: 'file',
      segments: [new Slot('corpus', CORPUS), new Slot('name', fileName, 'file_id')],
      leaf: true,
      filetype: ContentType.JSON,
    }),
  ]
}

/**
 * Build an app file's name from its title, id and modified date.
 *
 * The title takes whatever of the 255-byte NAME_MAX the date, the id and the
 * suffix leave, rather than a flat character count: those are the same number
 * only for ASCII, and a 100-character CJK title rendered a name ext4 and APFS
 * reject outright. The id never gives, so the name keeps addressing the file
 * -- same rule as gcal's event filenames. Sheets, Docs and Slides differ only
 * in the suffix. Mirrors Python's `app_filename`.
 */
export function appFilename(
  title: string,
  fileId: string,
  modifiedTime: string,
  suffix: string,
): string {
  const lead = modifiedTime.length >= DATE_LEN ? `${modifiedTime.slice(0, DATE_LEN)}_` : ''
  const fixed = byteLength(lead) + 2 + byteLength(fileId) + suffix.length
  return `${lead}${sanitizeTitle(title, NAME_MAX_BYTES - fixed)}__${fileId}${suffix}`
}
