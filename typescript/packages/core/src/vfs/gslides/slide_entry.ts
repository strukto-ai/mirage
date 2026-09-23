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

import { NAME_MAX_BYTES, byteLength, sanitizeLabel } from '../../utils/sanitize.ts'

const TITLE_MAX_CHARS = 100
const SUFFIX = '.gslide.json'
const DATE_LEN = 10

const sanitizeTitle = (title: string, maxBytes: number): string =>
  sanitizeLabel(title, { fallback: 'Untitled', maxLen: TITLE_MAX_CHARS, maxBytes })

/**
 * Build a filename from title, doc ID, and modified date.
 *
 * The title takes whatever of the 255-byte NAME_MAX the date, the id and the
 * suffix leave, rather than a flat character count: those are the same number
 * only for ASCII, and a 100-character CJK title rendered a name ext4 and APFS
 * reject outright. The id never gives, so the name keeps addressing the
 * document -- same rule as gcal's event filenames.
 */
export function makeFilename(title: string, docId: string, modifiedTime = ''): string {
  const lead = modifiedTime.length >= DATE_LEN ? `${modifiedTime.slice(0, DATE_LEN)}_` : ''
  const fixed = byteLength(lead) + 2 + byteLength(docId) + SUFFIX.length
  return `${lead}${sanitizeTitle(title, NAME_MAX_BYTES - fixed)}__${docId}${SUFFIX}`
}
